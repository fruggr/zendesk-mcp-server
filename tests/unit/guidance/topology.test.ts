import { describe, expect, it, vi } from 'vitest';
import { ZendeskApiError } from '../../../src/client/zendesk-api';
import {
  createTopologyProvider,
  fetchTopology,
  formatTopology,
  type TopologyData,
} from '../../../src/guidance/topology';
import { errorHandlers, manySectionsHandler } from '../../msw-handlers';
import { mswServer } from '../../setup';

const SUBDOMAIN = 'testsubdomain';
const TOKEN = 'test-token';

describe('fetchTopology', () => {
  it('aggregates locales, the category/section tree, visibility, permission groups and the current user', async () => {
    const data = await fetchTopology(SUBDOMAIN, TOKEN);

    expect(data.locales.default_locale).toBe('en-us');
    expect(data.locales.locales).toContain('fr');
    expect(data.categories.map((c) => c.id)).toEqual([800]);
    expect(data.sections.map((s) => s.id)).toEqual([600]);
    expect(data.sections[0]?.category_id).toBe(800);
    expect(data.sectionsHasMore).toBe(false);
    expect(data.userSegments.map((s) => s.id)).toEqual([15001]);
    expect(data.permissionGroups.map((g) => g.id)).toEqual([12001]);
    expect(data.currentUser.id).toBe(9999);
    expect(data.currentUser.role).toBe('admin');
  });

  it('flags has_more when the Help Center has more sections than a page', async () => {
    mswServer.use(manySectionsHandler);
    const data = await fetchTopology(SUBDOMAIN, TOKEN);
    expect(data.sectionsHasMore).toBe(true);
  });
});

const baseData = (): TopologyData => ({
  subdomain: SUBDOMAIN,
  locales: { locales: ['en-us', 'fr'], default_locale: 'en-us' },
  categories: [
    {
      id: 800,
      name: 'General',
      description: 'General category',
      locale: 'en-us',
      position: 0,
      created_at: '',
      updated_at: '',
    },
  ],
  sections: [
    {
      id: 600,
      name: 'FAQ',
      description: 'Frequently asked questions',
      locale: 'en-us',
      category_id: 800,
      position: 0,
      created_at: '',
      updated_at: '',
    },
  ],
  sectionsHasMore: false,
  userSegments: [
    {
      id: 15001,
      name: 'Signed-in users',
      user_type: 'signed_in_users',
      built_in: true,
      created_at: '',
      updated_at: '',
    },
  ],
  permissionGroups: [
    { id: 12001, name: 'Editors', built_in: false, created_at: '', updated_at: '' },
  ],
  currentUser: {
    id: 9999,
    name: 'Test User',
    email: 'test@example.com',
    role: 'admin',
    role_type: null,
    organization_id: 400,
    active: true,
    created_at: '',
    updated_at: '',
  },
});

describe('formatTopology', () => {
  it('renders every structural group with IDs', () => {
    const text = formatTopology(baseData());
    expect(text).toContain('testsubdomain');
    expect(text).toContain('en-us');
    expect(text).toContain('General');
    expect(text).toContain('(800)');
    expect(text).toContain('FAQ');
    expect(text).toContain('(600)');
    expect(text).toContain('Editors');
    expect(text).toContain('(12001)');
    expect(text).toContain('Signed-in users');
    expect(text).toContain('(15001)');
    expect(text).toContain('admin');
  });

  it('switches to summary mode (no partial tree) when sections are truncated', () => {
    const text = formatTopology({ ...baseData(), sections: [], sectionsHasMore: true });
    expect(text).toContain('list_sections');
    // Categories are still listed, but the section heading "FAQ" is not.
    expect(text).toContain('General');
    expect(text).not.toContain('FAQ');
  });
});

describe('createTopologyProvider', () => {
  it('coalesces reads within the TTL into a single fetch', async () => {
    const getToken = vi.fn(() => TOKEN);
    const provider = createTopologyProvider(getToken, SUBDOMAIN);

    const [a, b] = await Promise.all([provider.read(), provider.read()]);

    expect(a).toBe(b);
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed fetch — the next read retries', async () => {
    let calls = 0;
    const getToken = vi.fn(() => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return TOKEN;
    });
    const provider = createTopologyProvider(getToken, SUBDOMAIN);

    await expect(provider.read()).rejects.toThrow('boom');
    await expect(provider.read()).resolves.toContain('testsubdomain');
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it('notifies onUnauthorized when Zendesk returns 401', async () => {
    mswServer.use(errorHandlers.localesUnauthorized);
    const onUnauthorized = vi.fn();
    const provider = createTopologyProvider(() => TOKEN, SUBDOMAIN, onUnauthorized);

    await expect(provider.read()).rejects.toBeInstanceOf(ZendeskApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
