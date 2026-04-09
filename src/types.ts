export interface ZendeskTicket {
  id: number;
  subject: string;
  description: string;
  status: string;
  priority: string | null;
  type: string | null;
  assignee_id: number | null;
  requester_id: number;
  group_id: number | null;
  organization_id: number | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  custom_fields: Array<{ id: number; value: unknown }>;
}

export interface ZendeskComment {
  id: number;
  body: string;
  author_id: number;
  public: boolean;
  created_at: string;
}

export interface ZendeskUser {
  id: number;
  name: string;
  email: string;
  role: string;
  role_type: number | null;
  organization_id: number | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ZendeskOrganization {
  id: number;
  name: string;
  details: string | null;
  notes: string | null;
  domain_names: string[];
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface ZendeskArticle {
  id: number;
  title: string;
  body: string;
  locale: string;
  source_locale: string;
  author_id: number;
  section_id: number;
  permission_group_id: number;
  draft: boolean;
  promoted: boolean;
  position: number;
  label_names: string[];
  created_at: string;
  updated_at: string;
}

export interface ZendeskPermissionGroup {
  id: number;
  name: string;
  built_in: boolean;
  created_at: string;
  updated_at: string;
}

export interface ZendeskTranslation {
  id: number;
  locale: string;
  title: string;
  body: string;
  draft: boolean;
  created_at: string;
  updated_at: string;
  source_id: number;
  source_type: string;
}

export interface ZendeskCategory {
  id: number;
  name: string;
  description: string;
  locale: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface ZendeskSection {
  id: number;
  name: string;
  description: string;
  locale: string;
  category_id: number;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface PaginationMeta {
  has_more: boolean;
  after_cursor: string | null;
  count: number;
}

export interface ZendeskListResponse<T> {
  results?: T[];
  tickets?: T[];
  users?: T[];
  organizations?: T[];
  articles?: T[];
  categories?: T[];
  sections?: T[];
  comments?: T[];
  translations?: T[];
  permission_groups?: T[];
  meta?: {
    has_more: boolean;
    after_cursor: string;
  };
  count?: number;
  next_page?: string | null;
}
