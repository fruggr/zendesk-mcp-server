import * as z from 'zod/v4';
import { ZendeskApiError, zendeskGet, zendeskPost, zendeskPut } from '../client/zendesk-api';
import {
  DEFAULT_PAGE_SIZE,
  MAX_COMMENT_PAGES,
  MAX_PAGE_SIZE,
  TICKET_FIELD_SCAN_MAX_PAGES,
} from '../constants';
import type {
  ZendeskComment,
  ZendeskFormCondition,
  ZendeskListResponse,
  ZendeskRequest,
  ZendeskRequestCommentAuthor,
  ZendeskTicketField,
  ZendeskTicketForm,
} from '../types';
import {
  formatList,
  formatRequest,
  formatRequestComment,
  truncateIfNeeded,
} from '../utils/formatting';
import {
  buildOffsetParams,
  extractOffsetPaginationMeta,
  PAGE_DESC,
  PER_PAGE_DESC,
} from '../utils/pagination';
import {
  type AttachmentInput,
  attachmentSchema,
  formatAttachmentSuffix,
  uploadAttachments,
} from './attachments';
import type { ToolContext, ToolDefinition } from './definitions';

// Zendesk reserves `/api/v2/requests` for requesters; the agent paths
// (`/tickets`, `/search`) answer 403 for an end user, and vice versa some of
// these behave differently under an agent token. This message is thrown in
// place of the generic "Permission denied" so the caller learns which surface
// they are on rather than which HTTP code came back.
//
// ASCII only, same as the other rewritten auth messages: these can travel
// through header-adjacent paths that reject non-ASCII bytes.
const forbidden = (tool: string, endpoint: string, error: ZendeskApiError): Error =>
  new Error(
    `${tool} reads the end-user Requests surface (${endpoint}), which Zendesk serves to a ` +
      'signed-in requester. The current token was refused (HTTP 403). Either the Help Center ' +
      'is closed to this account, or this token is not a Help-Center-enabled user. For the ' +
      'agent-side equivalents use create_ticket, get_ticket, list_tickets or add_public_comment ' +
      '(namespace: tickets).',
    { cause: error },
  );

/** Run `fetch`, rewriting a 403 into guidance naming the end-user surface. */
const withForbiddenGuidance = async <T>(
  tool: string,
  endpoint: string,
  fetch: () => Promise<T>,
): Promise<T> => {
  try {
    return await fetch();
  } catch (error) {
    if (error instanceof ZendeskApiError && error.status === 403) {
      throw forbidden(tool, endpoint, error);
    }
    throw error;
  }
};

// The forms a customer may actually pick from. `active=true` is load-bearing:
// Zendesk already hides forms that are not `end_user_visible` from an end-user
// token, but it does NOT hide inactive ones. `fallback_to_default=true` returns
// the default form when nothing else matches, so an account with a single form
// degrades to that form rather than to an empty list.
const END_USER_FORM_PARAMS = {
  active: 'true',
  end_user_visible: 'true',
  fallback_to_default: 'true',
} as const;

/**
 * Walk an offset-paginated listing to the end, following `next_page` and
 * nothing else.
 *
 * `next_page` is the only trustworthy end-of-list signal on these endpoints:
 * `count` can be the pre-filter total, and a short page can still be followed
 * by another. Hitting the cap throws rather than returning a partial list --
 * for both callers a missing entry is worse than an error, because it makes a
 * form invisible or a required field unenforced, and the caller then gets a
 * confidently wrong "no such form" or an opaque Zendesk 422.
 */
const fetchAllPages = async <T>(
  subdomain: string,
  token: string,
  tool: string,
  path: string,
  extract: (response: ZendeskListResponse<T>) => T[] | undefined,
  params: Record<string, string> = {},
  maxPages = TICKET_FIELD_SCAN_MAX_PAGES,
): Promise<T[]> => {
  const items: T[] = [];
  let page = 1;
  while (true) {
    const response = await withForbiddenGuidance(tool, `GET ${path}`, () =>
      zendeskGet<ZendeskListResponse<T>>(subdomain, token, path, {
        ...params,
        ...buildOffsetParams(MAX_PAGE_SIZE, page),
      }),
    );
    items.push(...(extract(response) ?? []));
    if (!response.next_page) return items;
    if (page >= maxPages) {
      throw new Error(
        `${tool} could not read all of ${path}: the account exposes more than ${maxPages} ` +
          'pages of it. Continuing from a partial list would hide entries and produce a ' +
          'confidently wrong answer, so this stops here. Raise ' +
          'ZENDESK_TICKET_FIELD_SCAN_MAX_PAGES and retry.',
      );
    }
    page += 1;
  }
};

// Paginated for the same reason the field listing is: an account with more
// forms than fit one page would otherwise have some of them invisible to
// `list_request_forms`, and `resolveForm` would reject their ids with "no
// request form with id X is available to you" -- a confident refusal of a form
// that does exist.
const fetchEndUserForms = async (
  subdomain: string,
  token: string,
  tool: string,
): Promise<ZendeskTicketForm[]> =>
  fetchAllPages<ZendeskTicketForm>(
    subdomain,
    token,
    tool,
    '/ticket_forms',
    (response) => response.ticket_forms,
    END_USER_FORM_PARAMS,
  );

/**
 * Every ticket field the caller can see, paged defensively.
 *
 * `GET /ticket_fields` cannot be trusted to say when it is done. Under an
 * end-user token its `count` is the UNFILTERED total (27 while returning 8
 * objects with `next_page: null`), and in cursor mode `page[size]` is applied
 * before the visibility filter, so a short page is not the last page. So this
 * follows `next_page` and nothing else, bounded by a page cap.
 *
 * The per-field lookup would be the obvious alternative and is not available:
 * `GET /ticket_fields/{id}` answers 403 for an end user. The list is the only
 * way in.
 */
const fetchVisibleTicketFields = async (
  subdomain: string,
  token: string,
  tool: string,
): Promise<ZendeskTicketField[]> => {
  const fields = await fetchAllPages<ZendeskTicketField>(
    subdomain,
    token,
    tool,
    '/ticket_fields',
    (response) => response.ticket_fields,
  );
  // Zendesk already filters to portal-visible fields for an end-user token but
  // not for an agent one, so filter here too: the same tool must describe the
  // same form whichever identity calls it.
  return fields.filter((field) => field.visible_in_portal !== false);
};

/**
 * Every public comment on a request, paged.
 *
 * `get_request` promises the whole conversation, so it has to page: one GET
 * stops at Zendesk's page size, and a long-running ticket would lose its
 * oldest exchanges with nothing to say so. Bounded by the same cap the
 * agent-side comment walk uses.
 *
 * The `users` sideload accumulates across pages -- it is what attributes each
 * comment, and a later page's authors need not appear in the first page's.
 */
const fetchAllRequestComments = async (
  subdomain: string,
  token: string,
  requestId: number,
): Promise<{ comments: ZendeskComment[]; authors: Map<number, ZendeskRequestCommentAuthor> }> => {
  const comments: ZendeskComment[] = [];
  const authors = new Map<number, ZendeskRequestCommentAuthor>();
  let page = 1;
  while (page <= MAX_COMMENT_PAGES) {
    const response = await withForbiddenGuidance(
      'get_request',
      `GET /requests/${requestId}/comments`,
      () =>
        zendeskGet<ZendeskListResponse<ZendeskComment> & { users?: ZendeskRequestCommentAuthor[] }>(
          subdomain,
          token,
          `/requests/${requestId}/comments`,
          buildOffsetParams(MAX_PAGE_SIZE, page),
        ),
    );
    comments.push(...(response.comments ?? []));
    for (const user of response.users ?? []) authors.set(user.id, user);
    if (!response.next_page) break;
    page += 1;
  }
  return { comments, authors };
};

// Zendesk field `type` values for the built-in fields every form carries. They
// are NOT things a submitter sends in `custom_fields`: `subject` and
// `description` are this tool's own `subject`/`body` parameters, and the rest
// are agent-side (status, priority, type, group, assignee, tags) and dropped
// outright when an end user sets them.
//
// This matters more than it looks. A real form's `ticket_field_ids` includes
// the system subject and description, and both are marked required in the
// portal -- so treating every id in that list as a custom field to collect
// would make `create_request` demand "Subject (field id 1)" in `custom_fields`
// and refuse every submission, which no caller could satisfy.
const SYSTEM_FIELD_TYPES: ReadonlySet<string> = new Set([
  'subject',
  'description',
  'status',
  'tickettype',
  'priority',
  'group',
  'assignee',
  'tags',
]);

const isCustomField = (field: ZendeskTicketField): boolean => !SYSTEM_FIELD_TYPES.has(field.type);

const formSummary = (form: ZendeskTicketForm): string =>
  [
    `- **${form.display_name || form.name}** (form id ${form.id})${form.default ? ' — default' : ''}`,
    form.display_name && form.display_name !== form.name ? `  - Internal name: ${form.name}` : '',
  ]
    .filter(Boolean)
    .join('\n');

// One field as a submitter needs to see it: the portal label, whether it is
// required of them, and the exact option values Zendesk will accept.
const fieldSpec = (field: ZendeskTicketField): string => {
  const options = field.custom_field_options ?? field.system_field_options ?? [];
  return [
    `### ${field.title_in_portal || field.title} (field id ${field.id})`,
    `- **Type**: ${field.type} | **${field.required_in_portal ? 'required' : 'optional'}**`,
    field.description ? `- **Help text**: ${field.description}` : '',
    options.length > 0 ? '- **Accepted values** (label → value to send):' : '',
    ...options.map((option) => `  - ${option.name} → ${option.value}`),
  ]
    .filter(Boolean)
    .join('\n');
};

// Conditions are surfaced as data, not evaluated. Which fields a submitter
// actually sees can depend on answers already given, and whether the Requests
// API enforces that server-side is unverified -- so the model is told the rule
// and left to conduct the conversation, rather than being handed a field list
// that is wrong for half the answers.
const conditionSpec = (condition: ZendeskFormCondition): string => {
  const children = (condition.child_fields ?? [])
    .map((child) => `field ${child.id}${child.is_required ? ' (then required)' : ''}`)
    .join(', ');
  return `- When field ${condition.parent_field_id} is \`${String(condition.value)}\`: ${
    children || 'no additional fields'
  }`;
};

const renderFormSpec = (form: ZendeskTicketForm, fields: ZendeskTicketField[]): string => {
  const byId = new Map(fields.map((field) => [field.id, field]));
  // Ordered by the form, not by the field listing: that order is what the
  // portal shows and what a submitter should be asked in. System fields are
  // dropped here -- subject and description are create_request's own
  // parameters, and the rest are agent-side.
  const formFields = form.ticket_field_ids
    .map((id) => byId.get(id))
    .filter((field): field is ZendeskTicketField => field !== undefined)
    .filter(isCustomField);
  const required = formFields.filter((field) => field.required_in_portal);
  const conditions = form.end_user_conditions ?? [];

  return [
    `# ${form.display_name || form.name} (form id ${form.id})`,
    '',
    'Always needed: a subject and a description (the `subject` and `body` parameters',
    'of create_request). The fields below are what this form asks for on top of those.',
    '',
    required.length > 0
      ? `**Required**: ${required.map((f) => f.title_in_portal || f.title).join(', ')}`
      : '**Required**: nothing beyond the subject and description.',
    conditions.length > 0
      ? [
          '',
          '## Conditional fields',
          'Some fields appear, or become required, only for certain answers. Ask for them once',
          'the controlling answer is known rather than up front:',
          ...conditions.map(conditionSpec),
        ].join('\n')
      : '',
    '',
    '## Fields',
    '',
    formFields.length > 0
      ? formFields.map(fieldSpec).join('\n\n')
      : 'This form exposes no custom fields; send subject and body only.',
  ]
    .filter(Boolean)
    .join('\n');
};

/**
 * Refuse a submission the API would accept and quietly mangle.
 *
 * Two silent failures are guarded here. An unknown `ticket_form_id` makes
 * Zendesk answer 201 having substituted the account's DEFAULT form, so the
 * request lands on the wrong form with no error at all. And a missing
 * `required_in_portal` field is enforced only against end users -- an agent
 * token gets 201 with an empty subject -- so an agent-side check would pass
 * where a customer's submission fails.
 *
 * Only UNCONDITIONALLY required fields are enforced. A field required through
 * `end_user_conditions` depends on answers we may not have, and blocking on it
 * would refuse valid submissions; Zendesk's own 422 is the backstop there.
 */
const validateSubmission = (
  form: ZendeskTicketForm,
  fields: ZendeskTicketField[],
  provided: Array<{ id: number; value: unknown }>,
): void => {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const providedIds = new Set(
    provided.filter((entry) => entry.value !== null && entry.value !== '').map((e) => e.id),
  );
  const missing = form.ticket_field_ids
    .map((id) => byId.get(id))
    .filter((field): field is ZendeskTicketField => field?.required_in_portal === true)
    // System fields are excluded: `subject` and `description` arrive as this
    // tool's own parameters (and are already `.min(1)`), and the agent-side
    // ones cannot be set by an end user at all. Enforcing them as
    // `custom_fields` entries would refuse every submission.
    .filter(isCustomField)
    .filter((field) => !providedIds.has(field.id));

  if (missing.length > 0) {
    const list = missing
      .map((field) => `${field.title_in_portal || field.title} (field id ${field.id})`)
      .join(', ');
    throw new Error(
      `This form requires values the submission does not carry: ${list}. Ask for them, then ` +
        'resend with those ids in custom_fields. Call get_request_form for their accepted values.',
    );
  }
};

const REQUEST_STATUS = z.enum(['new', 'open', 'pending', 'hold', 'solved', 'closed']);

export const createRequestTools = (ctx: ToolContext): ToolDefinition[] => {
  const { subdomain, getToken } = ctx;

  // Resolve a form id to the form and the fields it needs, in one place: both
  // get_request_form and create_request start from exactly this.
  const resolveForm = async (
    tool: string,
    token: string,
    formId: number | undefined,
  ): Promise<{ form: ZendeskTicketForm; fields: ZendeskTicketField[] }> => {
    const [forms, fields] = await Promise.all([
      fetchEndUserForms(subdomain, token, tool),
      fetchVisibleTicketFields(subdomain, token, tool),
    ]);
    if (forms.length === 0) {
      throw new Error(
        `No request form is available to this user on ${subdomain}.zendesk.com. The Help Center ` +
          'may be closed, or no form is marked visible to end users. An agent can still open a ' +
          'ticket with create_ticket (namespace: tickets).',
      );
    }
    const form =
      formId === undefined ? forms.find((f) => f.default) : forms.find((f) => f.id === formId);
    if (!form) {
      const available = forms.map((f) => `${f.display_name || f.name} (${f.id})`).join(', ');
      throw new Error(
        formId === undefined
          ? `No default request form on ${subdomain}.zendesk.com. Pick one explicitly: ${available}.`
          : `No request form with id ${formId} is available to you. Available: ${available}. ` +
              'Sending an unknown id would make Zendesk silently substitute the default form, so ' +
              'this is refused rather than guessed.',
      );
    }
    return { form, fields };
  };

  return [
    {
      name: 'list_request_forms',
      namespace: 'requests',
      readOnly: true,
      title: 'List Request Forms',
      description:
        'List the kinds of request you can submit to this Zendesk — the forms a customer picks between on the Help Center, such as "Report a bug" or "Feature request". Returns each form\'s customer-facing name, its numeric id, and which one is the account default. Call this first when opening a request so the user chooses the right kind, then get_request_form to learn what that form asks for. Only forms that are active and visible to end users are listed; an account with a single form returns just that one. This is the end-user view: agents picking a form for someone else want list_ticket_fields and create_ticket instead.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async () => {
        const token = await getToken();
        const forms = await fetchEndUserForms(subdomain, token, 'list_request_forms');
        if (forms.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No request form is available to you on this Zendesk. The Help Center may be closed, or no form is marked visible to end users.',
              },
            ],
          };
        }
        const text = [
          `${forms.length} kind(s) of request available:`,
          '',
          forms.map(formSummary).join('\n'),
          '',
          'Call get_request_form with a form id to see the questions it asks.',
        ].join('\n');
        return { content: [{ type: 'text', text: truncateIfNeeded(text) }] };
      },
    },
    {
      name: 'get_request_form',
      namespace: 'requests',
      readOnly: true,
      title: 'Get Request Form',
      description:
        'Read what one request form actually asks for, so the user can be walked through it question by question. Returns the fields on that form in the order the portal shows them, each with its customer-facing label, whether it is required, and for dropdowns the exact values Zendesk accepts — plus any conditional rules ("if Type is Bug, Version becomes required"). Joins the form definition with the field definitions, because the form itself carries only field ids. Use it after list_request_forms and before create_request; omit form_id to describe the account default form. Conditional fields are reported as rules rather than resolved, since which ones apply depends on answers not yet given.',
      inputSchema: z.object({
        form_id: z
          .number()
          .int()
          .optional()
          .describe(
            'Form id whose questions to read, as returned by list_request_forms. Omit to describe the account default form.',
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { form_id } = params as { form_id?: number };
        const token = await getToken();
        const { form, fields } = await resolveForm('get_request_form', token, form_id);
        return {
          content: [{ type: 'text', text: truncateIfNeeded(renderFormSpec(form, fields)) }],
        };
      },
    },
    {
      name: 'create_request',
      namespace: 'requests',
      readOnly: false,
      title: 'Submit a Request',
      description:
        'Submit a new support request as the signed-in user — the MCP equivalent of the Help Center\'s "Submit a request" form. Returns the created request with its number, which the user can then follow with list_requests and get_request. Required fields are checked before sending: an unknown form id, or a missing field the form marks required, is refused here rather than sent, because Zendesk would answer 201 having silently substituted the default form or accepted an empty subject. Call get_request_form first to learn which fields to gather. Priority and type cannot be set by an end user — Zendesk drops them — so triage is left to the agents. This posts as the authenticated user; an agent opening a ticket on someone else\'s behalf wants create_ticket instead.',
      inputSchema: z.object({
        subject: z
          .string()
          .min(1)
          .describe(
            'One-line summary of the request, shown as the ticket title to the support agents who pick it up.',
          ),
        body: z
          .string()
          .min(1)
          .describe(
            'The request itself: what happened, what was expected, and any steps to reproduce. Becomes the first public comment on the ticket.',
          ),
        form_id: z
          .number()
          .int()
          .optional()
          .describe(
            'Form id chosen from list_request_forms, deciding which questions apply. Omit to use the account default form.',
          ),
        custom_fields: z
          .array(z.object({ id: z.number().int(), value: z.unknown() }))
          .optional()
          .describe(
            "Answers to the form's own questions, as { id, value } pairs. Take both the ids and the accepted values from get_request_form; a value Zendesk does not recognise is dropped without an error.",
          ),
        attachments: z
          .array(attachmentSchema)
          .optional()
          .describe(
            'Files to attach to the request, such as a screenshot or a log, with their content base64-encoded.',
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { subject, body, form_id, custom_fields, attachments } = params as {
          subject: string;
          body: string;
          form_id?: number;
          custom_fields?: Array<{ id: number; value: unknown }>;
          attachments?: AttachmentInput[];
        };
        const token = await getToken();
        const { form, fields } = await resolveForm('create_request', token, form_id);
        validateSubmission(form, fields, custom_fields ?? []);

        const uploads = attachments?.length
          ? [await uploadAttachments(subdomain, token, attachments)]
          : undefined;

        const { request } = await withForbiddenGuidance('create_request', 'POST /requests', () =>
          zendeskPost<{ request: ZendeskRequest }>(subdomain, token, '/requests', {
            request: {
              subject,
              ticket_form_id: form.id,
              comment: { body, ...(uploads && { uploads }) },
              ...(custom_fields && { custom_fields }),
            },
          }),
        );
        const suffix = formatAttachmentSuffix(attachments?.length);
        return {
          content: [
            {
              type: 'text',
              text: `Request #${request.id} submitted${suffix}.\n\n${formatRequest(request)}`,
            },
          ],
        };
      },
    },
    {
      name: 'list_requests',
      namespace: 'requests',
      readOnly: true,
      title: 'List My Requests',
      description:
        "List the requests the signed-in user submitted, newest activity first by default. Returns each request with its number, subject, status and whether the user can mark it solved; pass a query to search their own requests by free text instead of listing all of them. Scoped to the caller by Zendesk itself — it can never return anyone else's tickets — which is why an agent calling this sees only requests they raised, not their queue. Use get_request to read one with its full conversation. Agents wanting a queue want list_tickets, search_tickets or get_view_tickets instead.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Free text to match against the caller's own requests. When given, the search endpoint is used instead of the plain listing; omit it to list everything.",
          ),
        status: z
          .array(REQUEST_STATUS)
          .min(1)
          .optional()
          .describe(
            'Restrict to these ticket states, e.g. ["open","pending"] for anything still being worked. Validated here because Zendesk silently returns every request when it does not recognise a status.',
          ),
        sort_by: z
          .enum(['created_at', 'updated_at'])
          .default('updated_at')
          .describe(
            'Which timestamp orders the results: updated_at surfaces recent activity, created_at the newest submissions.',
          ),
        sort_order: z
          .enum(['asc', 'desc'])
          .default('desc')
          .describe(
            'Direction of that ordering; desc puts the most recent first, which is what a user following their tickets wants.',
          ),
        per_page: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe(PER_PAGE_DESC),
        page: z.number().int().min(1).default(1).describe(PAGE_DESC),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { query, status, sort_by, sort_order, per_page, page } = params as {
          query?: string;
          status?: string[];
          sort_by: string;
          sort_order: string;
          per_page: number;
          page: number;
        };
        const token = await getToken();
        // `per_page` is passed on BOTH paths on purpose: the search endpoint
        // otherwise defaults to 15 while the listing defaults to 100, and one
        // tool that silently paginates two ways is a trap.
        const path = query ? '/requests/search' : '/requests';
        const response = await withForbiddenGuidance('list_requests', `GET ${path}`, () =>
          zendeskGet<ZendeskListResponse<ZendeskRequest>>(subdomain, token, path, {
            ...(query && { query }),
            ...(status?.length && { status: status.join(',') }),
            sort_by,
            sort_order,
            ...buildOffsetParams(per_page, page),
          }),
        );
        const requests = response.requests ?? [];
        const meta = extractOffsetPaginationMeta(response, requests.length, per_page, page);
        if (requests.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: query
                  ? `No request of yours matches "${query}".`
                  : 'You have not submitted any request matching this filter.',
              },
            ],
          };
        }
        const header = query ? `Searched your requests for "${query}".` : 'Your requests.';
        return {
          content: [
            { type: 'text', text: `${header}\n\n${formatList(requests, formatRequest, meta)}` },
          ],
        };
      },
    },
    {
      name: 'get_request',
      namespace: 'requests',
      readOnly: true,
      title: 'Get My Request',
      description:
        'Read one of the signed-in user\'s own requests, optionally with the whole conversation on it. Returns the request\'s status, the form it was submitted on, whether the user may mark it solved, and — with include_comments — every public message on it, each labelled with its author and marked when that author is a support agent. Internal agent notes are never returned on this path, so nothing agent-private can leak through it. A request belonging to someone else answers "permission denied" rather than "not found", so a denial here does not tell you whether that id exists. Find the number with list_requests; agents reading a ticket they do not own want get_ticket instead.',
      inputSchema: z.object({
        request_id: z
          .number()
          .int()
          .describe(
            'Number of the request to read, as shown by list_requests or returned when it was submitted.',
          ),
        include_comments: z
          .boolean()
          .default(false)
          .describe(
            "When true, appends the full public conversation — agent replies and the user's own messages. Defaults to false so a status check stays cheap.",
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { request_id, include_comments } = params as {
          request_id: number;
          include_comments: boolean;
        };
        const token = await getToken();
        const { request } = await withForbiddenGuidance(
          'get_request',
          `GET /requests/${request_id}`,
          () =>
            zendeskGet<{ request: ZendeskRequest }>(subdomain, token, `/requests/${request_id}`),
        );
        let text = formatRequest(request);
        if (include_comments) {
          // The `users` sideload comes back by default and carries an `agent`
          // flag, which is what distinguishes a reply from the user's own
          // comment without inferring anything from ids.
          const { comments, authors } = await fetchAllRequestComments(subdomain, token, request_id);
          const thread = comments.map((c) => formatRequestComment(c, authors)).join('\n\n');
          text += `\n\n---\n# Conversation\n\n${thread}`;
        }
        return { content: [{ type: 'text', text: truncateIfNeeded(text) }] };
      },
    },
    {
      name: 'add_request_comment',
      namespace: 'requests',
      readOnly: false,
      title: 'Reply on My Request',
      description:
        "Reply on one of the signed-in user's own requests, optionally attaching files. Returns confirmation with the request's status after the reply, which matters because replying on a request that was already solved REOPENS it — Zendesk moves it back to open, and the user should know that is what their message did. The comment is always public: end users cannot post internal notes, and Zendesk silently ignores any attempt to mark one private. A closed request rejects new comments outright. Agents replying to a requester want add_public_comment, or add_private_note for an internal note.",
      inputSchema: z.object({
        request_id: z
          .number()
          .int()
          .describe('Number of the request to reply on, as shown by list_requests.'),
        body: z
          .string()
          .min(1)
          .describe(
            'The message to send. Visible to the support agents on the ticket and included in their email notification.',
          ),
        attachments: z
          .array(attachmentSchema)
          .optional()
          .describe(
            'Files to attach to this reply, such as a screenshot or a log, with their content base64-encoded.',
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { request_id, body, attachments } = params as {
          request_id: number;
          body: string;
          attachments?: AttachmentInput[];
        };
        const token = await getToken();
        const uploads = attachments?.length
          ? [await uploadAttachments(subdomain, token, attachments)]
          : undefined;
        const { request } = await withForbiddenGuidance(
          'add_request_comment',
          `PUT /requests/${request_id}`,
          () =>
            zendeskPut<{ request: ZendeskRequest }>(subdomain, token, `/requests/${request_id}`, {
              request: { comment: { body, ...(uploads && { uploads }) } },
            }),
        );
        const suffix = formatAttachmentSuffix(attachments?.length);
        return {
          content: [
            {
              type: 'text',
              text: `Reply added to request #${request_id}${suffix}. It is now **${request.status}**.`,
            },
          ],
        };
      },
    },
    {
      name: 'mark_request_solved',
      namespace: 'requests',
      readOnly: false,
      title: 'Mark My Request Solved',
      description:
        "Close one of the signed-in user's own requests, for when they consider it resolved. Returns the request's status read back from Zendesk, not merely an acknowledgement: this operation is refused unless the request is actually solvable by its requester, because Zendesk answers 200 and changes nothing when it is not, which would otherwise be reported as success. A request is only solvable once an agent has been assigned to it, so a brand-new or unassigned one cannot be closed this way — leave it, or reply with add_request_comment to say it is no longer needed. Marking an already-solved request solved again is a no-op. Agents closing a ticket want update_ticket with status solved.",
      inputSchema: z.object({
        request_id: z
          .number()
          .int()
          .describe(
            'Number of the request to close. Check get_request first: its "can you mark it solved" line has to say yes.',
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { request_id } = params as { request_id: number };
        const token = await getToken();
        const endpoint = `/requests/${request_id}`;

        // Read before writing. Zendesk accepts `solved: true` on a request the
        // requester may not solve, answers 200, and leaves the status alone --
        // so without this the tool would report a success that never happened.
        const { request: before } = await withForbiddenGuidance(
          'mark_request_solved',
          `GET ${endpoint}`,
          () => zendeskGet<{ request: ZendeskRequest }>(subdomain, token, endpoint),
        );
        if (before.status === 'solved' || before.status === 'closed') {
          return {
            content: [
              {
                type: 'text',
                text: `Request #${request_id} is already **${before.status}**. Nothing to do.`,
              },
            ],
          };
        }
        if (!before.can_be_solved_by_me) {
          return {
            content: [
              {
                type: 'text',
                text:
                  `Request #${request_id} cannot be marked solved by you: Zendesk only allows ` +
                  'that once an agent has been assigned to it. It is currently ' +
                  `**${before.status}**. Sending it anyway would return success and change ` +
                  'nothing, so it was not sent. Use add_request_comment to tell the agents it ' +
                  'is resolved on your side.',
              },
            ],
          };
        }

        const { request: after } = await withForbiddenGuidance(
          'mark_request_solved',
          `PUT ${endpoint}`,
          () =>
            zendeskPut<{ request: ZendeskRequest }>(subdomain, token, endpoint, {
              request: { solved: true },
            }),
        );
        // Verified from the response body rather than assumed from the 2xx.
        const text =
          after.status === 'solved'
            ? `Request #${request_id} is now **solved**.`
            : `Zendesk accepted the update but request #${request_id} is still **${after.status}**, ` +
              'so it was not solved. This usually means the assignment changed between the check ' +
              'and the update; re-read it with get_request.';
        return { content: [{ type: 'text', text }] };
      },
    },
  ];
};
