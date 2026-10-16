import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, Ban, Bookmark, Check, ChevronDown, CircleUserRound, Cloud, Code2, Copy, Database, ExternalLink, Eye, FileText, Folder, LayoutDashboard, LogOut, Moon, Newspaper, Pencil, Plus, RefreshCw, Search, Settings, ShieldCheck, Sun, Trash2, Users, X } from 'lucide-react';
import './styles.css';

type User = { id: string; username: string; role: 'admin' | 'user'; is_active?: number; created_at?: string; last_login_at?: string | null };
type Article = { id: string; url: string; title: string; description?: string | null; image_url?: string | null; source_name?: string | null; source_domain?: string | null; published_at?: string | null; category?: string | null; is_read?: number; is_skipped?: number; is_saved?: number; match_reason?: string };
type Query = {
  id: string;
  name: string;
  enabled: number;
  query_mode: string;
  expression: string;
  country?: string | null;
  language?: string | null;
  category?: string | null;
  domains?: string | null;
  exclude_domains?: string | null;
  raw_url?: string | null;
  sentiment?: string | null;
  sort?: string | null;
  removeduplicate?: number | null;
  custom_params?: string | null;
  generated_url?: string | null;
};
type FolderItem = { id: string; name: string; article_count?: number };
type Usage = { used: number; cap: number; remaining: number; date: string };
async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...options, credentials: 'same-origin', headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(typeof data === 'object' && data?.error ? data.error : `Request failed (${response.status})`);
  return data as T;
}
const prettyDate = (value?: string | null) => { if (!value) return ''; const d = new Date(value); return Number.isNaN(d.getTime()) ? value : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); };

function extractDomain(article: Article): string {
  try {
    if (article.url) {
      return new URL(article.url).hostname.replace(/^www\./, '').toLowerCase();
    }
  } catch {}
  if (article.source_domain) {
    try {
      if (article.source_domain.includes('://')) return new URL(article.source_domain).hostname.replace(/^www\./, '').toLowerCase();
      return article.source_domain.split('/')[0].replace(/^www\./, '').toLowerCase();
    } catch {}
  }
  return (article.source_name || '').toLowerCase().replace(/[^a-z0-9.-]/g, '');
}

function parsePastedUrl(urlStr: string) {
  if (!urlStr || !urlStr.trim()) return null;
  try {
    let search = '';
    const trimmed = urlStr.trim();
    if (trimmed.includes('?')) {
      search = trimmed.slice(trimmed.indexOf('?'));
    } else if (trimmed.includes('=')) {
      search = '?' + trimmed;
    }
    const sp = new URLSearchParams(search);
    let mode = 'qInMeta';
    let expr = '';
    if (sp.has('qInMeta')) { mode = 'qInMeta'; expr = sp.get('qInMeta') || ''; }
    else if (sp.has('qInTitle')) { mode = 'qInTitle'; expr = sp.get('qInTitle') || ''; }
    else if (sp.has('q')) { mode = 'q'; expr = sp.get('q') || ''; }

    return {
      raw_url: trimmed,
      query_mode: mode,
      expression: expr,
      country: sp.get('country') || '',
      language: sp.get('language') || '',
      category: sp.get('category') || '',
      domains: sp.get('domain') || sp.get('domains') || '',
      exclude_domains: sp.get('excludedomain') || '',
      sentiment: sp.get('sentiment') || '',
      sort: sp.get('sort') || '',
      removeduplicate: sp.get('removeduplicate') === '1' || sp.get('removeduplicate') === 'true'
    };
  } catch {
    return null;
  }
}

const initialQueryForm = {
  name: '',
  query_mode: 'qInMeta',
  expression: '',
  country: 'in',
  language: 'en,hi',
  category: 'business',
  domains: '',
  exclude_domains: '',
  raw_url: '',
  sentiment: 'positive',
  sort: 'relevancy',
  removeduplicate: true,
  custom_params: ''
};

function App() {
  const [me, setMe] = useState<User | null>(null);
  const [setupRequired, setSetupRequired] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState<'dashboard' | 'queries' | 'saved' | 'folders' | 'admin' | 'settings'>('dashboard');
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>(() => (localStorage.getItem('mynews-theme') as 'system' | 'light' | 'dark') || 'system');
  const [compact, setCompact] = useState(() => localStorage.getItem('mynews-compact') === 'true');
  const [textSize, setTextSize] = useState(() => Number(localStorage.getItem('mynews-text-size') || '16'));
  const [queries, setQueries] = useState<Query[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [selectedQuery, setSelectedQuery] = useState('');
  const [loadingNews, setLoadingNews] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [showUserForm, setShowUserForm] = useState(false);
  const [userForm, setUserForm] = useState({ username: '', password: '', role: 'user', is_active: true });
  const [showQueryForm, setShowQueryForm] = useState(false);
  const [editingQuery, setEditingQuery] = useState<Query | null>(null);
  const [showQueryInspector, setShowQueryInspector] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [queryForm, setQueryForm] = useState(initialQueryForm);
  const [previewArticle, setPreviewArticle] = useState<Article | null>(null);
  const [folderArticle, setFolderArticle] = useState<Article | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [setupForm, setSetupForm] = useState({ token: '', password: '', confirm: '' });
  const [loginForm, setLoginForm] = useState({ username: 'admin', password: '' });

  const currentQuery = useMemo(() => queries.find((q) => q.id === selectedQuery), [queries, selectedQuery]);

  const livePreviewUrl = useMemo(() => {
    if (queryForm.raw_url && queryForm.raw_url.trim()) return queryForm.raw_url.trim();
    const sp = new URLSearchParams();
    sp.set('apikey', 'YOUR_API_KEY');
    if (queryForm.expression) sp.set(queryForm.query_mode, queryForm.expression);
    if (queryForm.country) sp.set('country', queryForm.country);
    if (queryForm.language) sp.set('language', queryForm.language);
    if (queryForm.category) sp.set('category', queryForm.category);
    if (queryForm.domains) sp.set('domain', queryForm.domains);
    if (queryForm.exclude_domains) sp.set('excludedomain', queryForm.exclude_domains);
    if (queryForm.sentiment) sp.set('sentiment', queryForm.sentiment);
    if (queryForm.sort) sp.set('sort', queryForm.sort);
    if (queryForm.removeduplicate) sp.set('removeduplicate', '1');
    return `https://newsdata.io/api/1/latest?${sp.toString()}`;
  }, [queryForm]);

  const setMessage = (message: string) => { setNotice(message); setError(''); window.setTimeout(() => setNotice(''), 3500); };
  const setFailure = (message: string) => { setError(message); setNotice(''); };
  const loadBase = useCallback(async () => {
    const [queryData, folderData, usageData] = await Promise.all([
      api<{ queries: Query[] }>('/api/queries'), api<{ folders: FolderItem[] }>('/api/folders'), api<Usage>('/api/usage')
    ]);
    setQueries(queryData.queries); setFolders(folderData.folders); setUsage(usageData);
    setSelectedQuery((current) => current && queryData.queries.some((q) => q.id === current && q.enabled) ? current : queryData.queries.find((q) => q.enabled)?.id || '');
  }, []);
  const checkAuth = useCallback(async () => {
    try {
      const setup = await api<{ setupRequired: boolean }>('/api/setup/status'); setSetupRequired(setup.setupRequired);
      if (!setup.setupRequired) {
        try { const data = await api<{ user: User }>('/api/auth/me'); setMe(data.user); }
        catch { setMe(null); }
      }
    } catch (e) { setFailure(e instanceof Error ? e.message : 'Could not connect to MyNews API.'); }
    finally { setChecking(false); }
  }, []);
  useEffect(() => { void checkAuth(); }, [checkAuth]);
  useEffect(() => { document.documentElement.dataset.theme = theme; document.documentElement.style.setProperty('--article-font-size', `${textSize}px`); localStorage.setItem('mynews-theme', theme); localStorage.setItem('mynews-text-size', String(textSize)); localStorage.setItem('mynews-compact', String(compact)); }, [theme, textSize, compact]);
  useEffect(() => { if (!me) return; void loadBase().catch((e) => setFailure(e instanceof Error ? e.message : 'Could not load app data.')); }, [me, loadBase]);
  const refreshNews = useCallback(async (force = true) => {
    if (!selectedQuery) { setArticles([]); return; }
    setLoadingNews(true); setError('');
    try {
      const result = await api<{ articles: Article[]; usage?: Usage; cached?: boolean; queryUrl?: string }>(`/api/news?queryId=${encodeURIComponent(selectedQuery)}${force ? '&refresh=1' : ''}`);
      setArticles(result.articles.filter((a) => !a.is_skipped));
      if (result.usage) setUsage(result.usage as Usage); else setUsage(await api<Usage>('/api/usage'));
      setMessage(result.cached ? 'Showing recently cached articles.' : 'News refreshed.');
    } catch (e) { setFailure(e instanceof Error ? e.message : 'News refresh failed.'); }
    finally { setLoadingNews(false); }
  }, [selectedQuery]);
  useEffect(() => { if (me && page === 'dashboard' && selectedQuery) void refreshNews(false); }, [me, page, selectedQuery, refreshNews]);
  const loadUsers = useCallback(async () => { const data = await api<{ users: User[] }>('/api/admin/users'); setUsers(data.users); }, []);
  useEffect(() => { if (me?.role === 'admin' && page === 'admin') void loadUsers().catch((e) => setFailure(e instanceof Error ? e.message : 'Could not load users.')); }, [me, page, loadUsers]);
  const unreadCount = useMemo(() => articles.filter((a) => !a.is_read).length, [articles]);

  async function bootstrap(event: React.FormEvent) {
    event.preventDefault(); setError('');
    if (setupForm.password.length < 14) return setFailure('Choose a password of at least 14 characters.');
    if (setupForm.password !== setupForm.confirm) return setFailure('Passwords do not match.');
    try { await api('/api/setup/bootstrap', { method: 'POST', headers: { Authorization: `Bearer ${setupForm.token}` }, body: JSON.stringify({ password: setupForm.password }) }); setSetupRequired(false); setSetupForm({ token: '', password: '', confirm: '' }); setMessage('Administrator created. Sign in with username admin.'); }
    catch (e) { setFailure(e instanceof Error ? e.message : 'Setup failed.'); }
  }
  async function login(event: React.FormEvent) {
    event.preventDefault(); setError('');
    try { const data = await api<{ user: User }>('/api/auth/login', { method: 'POST', body: JSON.stringify(loginForm) }); setMe(data.user); setPage('dashboard'); setLoginForm({ username: 'admin', password: '' }); setMessage('Welcome to MyNews.'); }
    catch (e) { setFailure(e instanceof Error ? e.message : 'Login failed.'); }
  }
  async function logout() { try { await api('/api/auth/logout', { method: 'POST' }); } finally { setMe(null); setArticles([]); setQueries([]); setFolders([]); setPage('dashboard'); } }

  function openCreateQuery() {
    setEditingQuery(null);
    setQueryForm(initialQueryForm);
    setShowQueryForm(true);
  }

  function openEditQuery(q: Query) {
    setEditingQuery(q);
    setQueryForm({
      name: q.name,
      query_mode: q.query_mode || 'qInMeta',
      expression: q.expression || '',
      country: q.country || '',
      language: q.language || '',
      category: q.category || '',
      domains: q.domains || '',
      exclude_domains: q.exclude_domains || '',
      raw_url: q.raw_url || '',
      sentiment: q.sentiment || '',
      sort: q.sort || 'relevancy',
      removeduplicate: q.removeduplicate !== 0,
      custom_params: q.custom_params || ''
    });
    setShowQueryForm(true);
  }

  async function excludeSource(article: Article) {
    if (!selectedQuery) {
      setFailure('Please select a monitoring list first.');
      return;
    }
    const domain = extractDomain(article);
    if (!domain) {
      setFailure('Could not detect the publisher domain for this article.');
      return;
    }
    if (!window.confirm(`Exclude "${domain}" from this monitoring query?\nArticles from this domain will be omitted from future results.`)) {
      return;
    }
    try {
      const res = await api<{ success: boolean; excluded: string; query: Query }>(
        `/api/queries/${encodeURIComponent(selectedQuery)}/exclude-source`,
        { method: 'POST', body: JSON.stringify({ domain }) }
      );
      setMessage(`Source "${res.excluded}" excluded from query. Refreshing news…`);
      await loadBase();
      await refreshNews(true);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'Could not exclude source.');
    }
  }

  function handleUrlPaste(pasted: string) {
    const parsed = parsePastedUrl(pasted);
    if (parsed) {
      setQueryForm((prev) => ({
        ...prev,
        ...parsed,
        name: prev.name.trim() ? prev.name : (parsed.expression || 'News Query')
      }));
      setMessage('Query parameters extracted from URL.');
    } else {
      setQueryForm((prev) => ({ ...prev, raw_url: pasted }));
    }
  }

  async function saveQuery(event: React.FormEvent) {
    event.preventDefault();
    try {
      if (editingQuery) {
        await api(`/api/queries/${editingQuery.id}`, { method: 'PATCH', body: JSON.stringify(queryForm) });
        setMessage('Monitoring list updated.');
      } else {
        await api('/api/queries', { method: 'POST', body: JSON.stringify(queryForm) });
        setMessage('Monitoring query saved.');
      }
      setShowQueryForm(false);
      setEditingQuery(null);
      setQueryForm(initialQueryForm);
      await loadBase();
      setPage('queries');
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'Could not save query.');
    }
  }
  async function toggleQuery(query: Query) { try { await api(`/api/queries/${query.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !query.enabled }) }); await loadBase(); } catch (e) { setFailure(e instanceof Error ? e.message : 'Could not update query.'); } }
  async function deleteQuery(query: Query) { if (!window.confirm(`Delete monitoring list “${query.name}”?`)) return; try { await api(`/api/queries/${query.id}`, { method: 'DELETE' }); await loadBase(); setMessage('Monitoring list deleted.'); } catch (e) { setFailure(e instanceof Error ? e.message : 'Could not delete query.'); } }
  async function articleState(article: Article, changes: Record<string, boolean>) {
    try { await api(`/api/articles/${article.id}/state`, { method: 'PATCH', body: JSON.stringify(changes) }); setArticles((prev) => prev.map((a) => a.id === article.id ? { ...a, ...Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v ? 1 : 0])) } : a)); }
    catch (e) { setFailure(e instanceof Error ? e.message : 'Could not update article.'); }
  }
  async function createFolder(event: React.FormEvent) { event.preventDefault(); try { await api('/api/folders', { method: 'POST', body: JSON.stringify({ name: newFolderName }) }); setNewFolderName(''); setFolders((await api<{ folders: FolderItem[] }>('/api/folders')).folders); setMessage('Folder created.'); } catch (e) { setFailure(e instanceof Error ? e.message : 'Could not create folder.'); } }
  async function fileArticle(folderId: string) {
    if (!folderArticle) return;
    try {
      await api(`/api/articles/${folderArticle.id}/state`, { method: 'PATCH', body: JSON.stringify({ is_saved: true }) });
      await api('/api/folder-articles', { method: 'POST', body: JSON.stringify({ folder_id: folderId, article_id: folderArticle.id }) });
      setArticles((prev) => prev.map((a) => a.id === folderArticle.id ? { ...a, is_saved: 1 } : a)); setFolderArticle(null); setMessage('Article saved to folder.');
    } catch (e) { setFailure(e instanceof Error ? e.message : 'Could not save article to folder.'); }
  }
  async function saveUser(event: React.FormEvent) {
    event.preventDefault();
    try {
      if (editingUser) await api(`/api/admin/users/${editingUser.id}`, { method: 'PATCH', body: JSON.stringify({ username: userForm.username, password: userForm.password || undefined, role: userForm.role, is_active: userForm.is_active }) });
      else await api('/api/admin/users', { method: 'POST', body: JSON.stringify({ username: userForm.username, password: userForm.password, role: userForm.role }) });
      setShowUserForm(false); setEditingUser(null); setUserForm({ username: '', password: '', role: 'user', is_active: true }); await loadUsers(); setMessage(editingUser ? 'User updated.' : 'User created.');
    } catch (e) { setFailure(e instanceof Error ? e.message : 'Could not save user.'); }
  }
  function editUser(user: User) { setEditingUser(user); setUserForm({ username: user.username, password: '', role: user.role, is_active: user.is_active !== 0 }); setShowUserForm(true); }
  async function deleteUser(user: User) { if (!window.confirm(`Delete user “${user.username}”? Their sessions and personal data will be deleted.`)) return; try { await api(`/api/admin/users/${user.id}`, { method: 'DELETE' }); await loadUsers(); setMessage('User deleted.'); } catch (e) { setFailure(e instanceof Error ? e.message : 'Could not delete user.'); } }

  if (checking) return <div className="center-screen"><div className="spinner"/><span>Opening MyNews…</span></div>;
  if (setupRequired) return <main className="auth-shell"><section className="auth-card"><Brand/><div className="eyebrow">ONE-TIME SETUP</div><h1>Create your admin account</h1><p className="muted">The first account is always <b>admin</b>. Enter the bootstrap token configured as a Cloudflare secret, then choose a strong password. This screen becomes unavailable after setup.</p><form onSubmit={bootstrap} className="stack"><label>Bootstrap token<input required type="password" autoComplete="off" value={setupForm.token} onChange={(e) => setSetupForm({ ...setupForm, token: e.target.value })} placeholder="Paste the one-time setup token"/></label><label>New admin password<input required minLength={14} type="password" autoComplete="new-password" value={setupForm.password} onChange={(e) => setSetupForm({ ...setupForm, password: e.target.value })} placeholder="At least 14 characters"/></label><label>Confirm password<input required minLength={14} type="password" autoComplete="new-password" value={setupForm.confirm} onChange={(e) => setSetupForm({ ...setupForm, confirm: e.target.value })}/></label><Message error={error} notice={notice}/><button className="primary full" type="submit">Create administrator</button></form><p className="tiny muted">After successful setup, remove the BOOTSTRAP_TOKEN secret from Cloudflare.</p></section></main>;
  if (!me) return <main className="auth-shell"><section className="auth-card"><Brand/><div className="eyebrow">PRIVATE NEWS WORKSPACE</div><h1>Welcome back</h1><p className="muted">Sign in to your personal news-monitoring dashboard.</p><form onSubmit={login} className="stack"><label>Username<input required autoComplete="username" value={loginForm.username} onChange={(e) => setLoginForm({ ...loginForm, username: e.target.value })}/></label><label>Password<input required type="password" autoComplete="current-password" value={loginForm.password} onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })}/></label><Message error={error} notice={notice}/><button className="primary full" type="submit">Sign in <ChevronDown size={16}/></button></form><div className="security-note"><ShieldCheck size={17}/><span>Protected by server-side authentication</span></div></section></main>;

  const nav = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard }, { id: 'queries', label: 'Monitoring lists', icon: Search }, { id: 'saved', label: 'Saved articles', icon: Bookmark }, { id: 'folders', label: 'Folders', icon: Folder }, ...(me.role === 'admin' ? [{ id: 'admin', label: 'User management', icon: Users }] : []), { id: 'settings', label: 'Settings', icon: Settings }
  ] as const;
  return <div className="app-shell">
    <aside className="sidebar"><Brand/><div className="sidebar-label">WORKSPACE</div><nav>{nav.map((item) => <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => setPage(item.id as typeof page)}><item.icon size={18}/><span>{item.label}</span>{item.id === 'dashboard' && unreadCount > 0 && <b className="nav-count">{unreadCount}</b>}</button>)}</nav><div className="sidebar-bottom"><div className="quota-mini"><div className="quota-title"><Activity size={15}/> Daily API budget</div><div className="quota-value">{usage?.used ?? '—'} <span>/ {usage?.cap ?? '—'} credits</span></div><div className="progress"><span style={{ width: `${usage ? Math.min(100, usage.used / Math.max(1, usage.cap) * 100) : 0}%` }}/></div><div className="tiny muted">Manual refresh · Shared quota</div></div><button className="nav-item" onClick={logout}><LogOut size={18}/><span>Sign out</span></button></div></aside>
    <main className="main-area"><header className="topbar"><div className="mobile-brand"><Brand/></div><div className="topbar-title"><span className="eyebrow">MY WORKSPACE</span><h2>{({ dashboard: 'News dashboard', queries: 'Monitoring lists', saved: 'Saved articles', folders: 'Your folders', admin: 'User management', settings: 'Settings' } as Record<string, string>)[page]}</h2></div><div className="top-actions"><button className="icon-button" title="Toggle theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={18}/> : <Moon size={18}/>}</button><div className="profile-chip"><span className="avatar"><CircleUserRound size={18}/></span><span><b>{me.username}</b><small>{me.role === 'admin' ? 'Administrator' : 'Member'}</small></span></div></div></header>
      <div className="page-content"><Message error={error} notice={notice}/>
        {page === 'dashboard' && <>
          <section className="welcome-row"><div><div className="eyebrow">YOUR DAILY BRIEFING</div><h1>Stay informed, <span className="accent">on your terms.</span></h1><p className="muted">Your saved searches, one focused news feed. No algorithmic noise.</p></div><button className="primary" onClick={() => { setPage('queries'); openCreateQuery(); }}><Plus size={17}/> New monitoring list</button></section>
          <section className="stats-grid"><Stat icon={<Search size={18}/>} label="Monitoring lists" value={queries.filter((q) => q.enabled).length} detail={`${queries.length} saved total`}/><Stat icon={<Bookmark size={18}/>} label="Articles in view" value={articles.length} detail={`${unreadCount} unread`}/><Stat icon={<Cloud size={18}/>} label="API credits left" value={usage?.remaining ?? '—'} detail="Today's application budget"/></section>
          <section className="feed-toolbar">
            <div className="select-wrap">
              <label htmlFor="active-query">Showing news for</label>
              <select id="active-query" value={selectedQuery} onChange={(e) => setSelectedQuery(e.target.value)}>
                <option value="">Choose a monitoring list</option>
                {queries.filter((q) => q.enabled).map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
              </select>
            </div>
            <div className="query-inspector-actions">
              {currentQuery && (
                <>
                  <button className="secondary small-button" onClick={() => openEditQuery(currentQuery)} title="Edit this monitoring list">
                    <Pencil size={14}/> Edit query
                  </button>
                  <button className={`secondary small-button ${showQueryInspector ? 'active' : ''}`} onClick={() => setShowQueryInspector((prev) => !prev)} title="Inspect generated API query">
                    <Code2 size={14}/> {showQueryInspector ? 'Hide query' : 'Show query URL'}
                  </button>
                </>
              )}
              <button className="secondary" disabled={!selectedQuery || loadingNews} onClick={() => void refreshNews(true)}>
                {loadingNews ? <span className="spinner small"/> : <RefreshCw size={16}/>} Refresh news
              </button>
            </div>
          </section>

          {showQueryInspector && currentQuery && (
            <section className="query-inspector">
              <div className="query-inspector-header">
                <h4><Code2 size={16}/> NewsData.io API Query URL</h4>
                <div className="query-inspector-actions">
                  <button
                    className="secondary small-button"
                    onClick={async () => {
                      const urlToCopy = currentQuery.generated_url || '';
                      try { await navigator.clipboard.writeText(urlToCopy); setCopiedUrl(true); setTimeout(() => setCopiedUrl(false), 2000); }
                      catch { window.prompt('Copy query URL', urlToCopy); }
                    }}
                  >
                    {copiedUrl ? <Check size={14}/> : <Copy size={14}/>} {copiedUrl ? 'Copied URL!' : 'Copy URL'}
                  </button>
                  {currentQuery.generated_url && (
                    <a className="secondary small-button link-button" href={currentQuery.generated_url} target="_blank" rel="noreferrer">
                      <ExternalLink size={14}/> Open in new tab
                    </a>
                  )}
                </div>
              </div>
              <div className="query-url-display">
                <code>{currentQuery.generated_url || 'URL generating…'}</code>
              </div>
              <div className="query-tags">
                <span className="query-tag">Search mode: {currentQuery.query_mode}</span>
                <span className="query-tag">Keywords: {currentQuery.expression}</span>
                {currentQuery.country && <span className="query-tag">Country: {currentQuery.country}</span>}
                {currentQuery.language && <span className="query-tag">Languages: {currentQuery.language}</span>}
                {currentQuery.category && <span className="query-tag">Category: {currentQuery.category}</span>}
                {currentQuery.sentiment && <span className="query-tag">Sentiment: {currentQuery.sentiment}</span>}
                {currentQuery.sort && <span className="query-tag">Sort: {currentQuery.sort}</span>}
                {currentQuery.removeduplicate === 1 && <span className="query-tag accent-pill">Deduplication: ON</span>}
                {currentQuery.domains && <span className="query-tag">Domains: {currentQuery.domains}</span>}
                {currentQuery.exclude_domains && <span className="query-tag danger-pill">Excluded: {currentQuery.exclude_domains}</span>}
              </div>
            </section>
          )}

          {!queries.length ? <Empty icon={<Search size={24}/>} title="Create your first monitoring list" body="Use the query builder to define exactly what MyNews should look for." action={<button className="primary" onClick={() => { setPage('queries'); openCreateQuery(); }}><Plus size={16}/> Create query</button>}/> : !selectedQuery ? <Empty icon={<Newspaper size={24}/>} title="Choose an enabled query" body="Enable a monitoring list or create a new one to see its results."/> : loadingNews && !articles.length ? <div className="loading-panel"><div className="spinner"/>Fetching matching news…</div> : articles.length ? <div className={compact ? 'article-list compact' : 'article-list'}>{articles.filter((a) => !a.is_skipped).map((article) => <ArticleCard key={article.id} article={article} compact={compact} onPreview={() => setPreviewArticle(article)} onExcludeSource={() => void excludeSource(article)} onSave={() => setFolderArticle(article)} onRead={() => void articleState(article, { is_read: !article.is_read })} onSkip={() => void articleState(article, { is_skipped: true })}/>)}</div> : <Empty icon={<Newspaper size={24}/>} title="No articles yet" body="Refresh to search NewsData.io, or adjust your keywords and filters." action={<button className="secondary" onClick={() => void refreshNews(true)}><RefreshCw size={16}/> Try refresh</button>}/>}
        </>}
        {page === 'queries' && <section className="content-section">
          <div className="section-heading">
            <div>
              <h1>Your monitoring lists</h1>
              <p className="muted">Create up to 20 saved queries. Click Edit to tune keywords, filters, or paste full URLs.</p>
            </div>
            <button className="primary" disabled={queries.length >= 20} onClick={openCreateQuery}>
              <Plus size={16}/> New query
            </button>
          </div>

          {showQueryForm && (
            <form className="panel stack" onSubmit={saveQuery}>
              <div className="form-heading">
                <h3>{editingQuery ? `Edit monitoring list: ${editingQuery.name}` : 'New monitoring query'}</h3>
                <button type="button" className="icon-button" onClick={() => { setShowQueryForm(false); setEditingQuery(null); }}><X size={18}/></button>
              </div>

              <div className="url-paste-card">
                <label><Code2 size={15}/> Direct Query URL (Optional — Paste full NewsData.io URL)</label>
                <input
                  type="text"
                  value={queryForm.raw_url}
                  onChange={(e) => handleUrlPaste(e.target.value)}
                  placeholder="https://newsdata.io/api/1/latest?apikey=...&qInMeta=Indian%20railways&country=in&language=en,hi&category=business&sentiment=positive&sort=relevancy&removeduplicate=1"
                />
                <small className="muted">Pasting a URL automatically parses and populates the search mode, keywords, country, language, category, sentiment, and deduplication options below.</small>
              </div>

              <label>
                List name
                <input required maxLength={100} value={queryForm.name} onChange={(e) => setQueryForm({ ...queryForm, name: e.target.value })} placeholder="e.g. Indian Railways Monitoring"/>
              </label>

              <label>
                Search mode
                <select value={queryForm.query_mode} onChange={(e) => setQueryForm({ ...queryForm, query_mode: e.target.value })}>
                  <option value="qInMeta">qInMeta — Search in title, description & keywords (Recommended)</option>
                  <option value="qInTitle">qInTitle — Headlines / titles only</option>
                  <option value="q">q — Search across all supported fields</option>
                </select>
              </label>

              <label>
                Boolean search expression
                <textarea required maxLength={500} rows={3} value={queryForm.expression} onChange={(e) => setQueryForm({ ...queryForm, expression: e.target.value })} placeholder={'"Indian railways" OR "Railway Board"'}/>
                <small className="muted">Use the syntax supported by your NewsData.io plan.</small>
              </label>

              <div className="form-grid">
                <label>
                  Country code(s)
                  <input value={queryForm.country} onChange={(e) => setQueryForm({ ...queryForm, country: e.target.value })} placeholder="e.g. in or in,us"/>
                  <small className="muted">Supports comma-separated codes</small>
                </label>
                <label>
                  Language code(s)
                  <input value={queryForm.language} onChange={(e) => setQueryForm({ ...queryForm, language: e.target.value })} placeholder="e.g. en,hi"/>
                  <small className="muted">Supports multiple languages (e.g. en,hi)</small>
                </label>
                <label>
                  Category
                  <input value={queryForm.category} onChange={(e) => setQueryForm({ ...queryForm, category: e.target.value })} placeholder="e.g. business, top, technology"/>
                </label>
                <label>
                  Sentiment
                  <select value={queryForm.sentiment} onChange={(e) => setQueryForm({ ...queryForm, sentiment: e.target.value })}>
                    <option value="">Any sentiment (default)</option>
                    <option value="positive">positive (Positive sentiment)</option>
                    <option value="negative">negative (Negative sentiment)</option>
                    <option value="neutral">neutral (Neutral sentiment)</option>
                  </select>
                </label>
                <label>
                  Sort by
                  <select value={queryForm.sort} onChange={(e) => setQueryForm({ ...queryForm, sort: e.target.value })}>
                    <option value="relevancy">relevancy (Most relevant first)</option>
                    <option value="publishedAt">publishedAt (Newest first)</option>
                  </select>
                </label>
                <label>
                  Publisher domains (Optional)
                  <input value={queryForm.domains} onChange={(e) => setQueryForm({ ...queryForm, domains: e.target.value })} placeholder="domain1.com,domain2.com"/>
                </label>
                <label>
                  Exclude domains (Optional)
                  <input value={queryForm.exclude_domains} onChange={(e) => setQueryForm({ ...queryForm, exclude_domains: e.target.value })} placeholder="e.g. deccanherald.com, livemint.com"/>
                </label>
              </div>

              <label className="checkbox-label">
                <input type="checkbox" checked={queryForm.removeduplicate} onChange={(e) => setQueryForm({ ...queryForm, removeduplicate: e.target.checked })}/>
                Remove duplicate articles (<code>removeduplicate=1</code>)
              </label>

              <div className="live-preview-box">
                <div className="live-preview-header">
                  <span><Eye size={13}/> Generated NewsData.io Query Preview</span>
                  <button
                    type="button"
                    className="text-action"
                    onClick={async () => {
                      try { await navigator.clipboard.writeText(livePreviewUrl); setMessage('Preview URL copied.'); }
                      catch { window.prompt('Copy URL', livePreviewUrl); }
                    }}
                  >
                    <Copy size={13}/> Copy Preview URL
                  </button>
                </div>
                <code className="live-preview-code">{livePreviewUrl}</code>
              </div>

              <div className="row-actions">
                <button type="button" className="secondary" onClick={() => { setShowQueryForm(false); setEditingQuery(null); }}>Cancel</button>
                <button type="submit" className="primary">{editingQuery ? 'Update monitoring list' : 'Save query'}</button>
              </div>
            </form>
          )}

          {queries.length ? (
            <div className="query-list">
              {queries.map((q) => (
                <div className="query-item" key={q.id}>
                  <div className="query-symbol"><Search size={19}/></div>
                  <div className="query-main">
                    <div className="query-title-row">
                      <h3>{q.name}</h3>
                      <span className={`status-pill ${q.enabled ? 'enabled' : 'disabled'}`}>{q.enabled ? 'Enabled' : 'Paused'}</span>
                    </div>
                    <p>{q.expression || (q.raw_url ? 'Custom Direct URL query' : '')}</p>
                    <div className="query-meta">
                      {q.query_mode === 'qInTitle' ? 'Headlines' : q.query_mode === 'qInMeta' ? 'Metadata' : 'All fields'}
                      {q.country ? ` · ${q.country.toUpperCase()}` : ''}
                      {q.language ? ` · ${q.language}` : ''}
                      {q.category ? ` · ${q.category}` : ''}
                      {q.sentiment ? ` · ${q.sentiment}` : ''}
                      {q.sort ? ` · sort:${q.sort}` : ''}
                      {q.removeduplicate === 1 ? ' · deduplicated' : ''}
                      {q.exclude_domains ? ` · excluded:(${q.exclude_domains})` : ''}
                    </div>
                    {q.generated_url && (
                      <div style={{ marginTop: '8px' }}>
                        <button
                          type="button"
                          className="url-badge"
                          onClick={async (e) => {
                            e.stopPropagation();
                            try { await navigator.clipboard.writeText(q.generated_url || ''); setMessage('Query URL copied to clipboard.'); }
                            catch { window.prompt('Copy query URL', q.generated_url || ''); }
                          }}
                          title="Click to copy query URL"
                        >
                          <Code2 size={12}/> Copy API Query URL
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="query-actions">
                    <button className="secondary small-button" onClick={() => openEditQuery(q)} title="Edit monitoring list">
                      <Pencil size={14}/> Edit
                    </button>
                    <button className="secondary small-button" onClick={() => void toggleQuery(q)}>
                      {q.enabled ? 'Pause' : 'Enable'}
                    </button>
                    <button className="icon-button danger" title="Delete query" onClick={() => void deleteQuery(q)}>
                      <Trash2 size={16}/>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : !showQueryForm && (
            <Empty icon={<Search size={24}/>} title="No monitoring lists" body="Create a query to start tracking the topics you care about." action={<button className="primary" onClick={openCreateQuery}><Plus size={16}/> Create first query</button>}/>
          )}
        </section>}
        {page === 'saved' && <section className="content-section"><div className="section-heading"><div><h1>Saved articles</h1><p className="muted">Your reading list and bookmarks.</p></div><a className="secondary link-button" href="/api/export/bookmarks">Export JSON</a></div><div className="empty-panel"><Bookmark size={24}/><h3>Saved article library</h3><p>Articles you save from the dashboard will appear here. The export endpoint is ready for your saved links and notes.</p><button className="secondary" onClick={async () => { try { const data = await api<{ articles: Article[] }>('/api/bookmarks'); setArticles(data.articles); setPage('dashboard'); } catch (e) { setFailure(e instanceof Error ? e.message : 'Could not load bookmarks.'); } }}>Load saved articles</button></div></section>}
        {page === 'folders' && <section className="content-section"><div className="section-heading"><div><h1>Folders</h1><p className="muted">Organise saved articles around your interests.</p></div></div><form className="inline-create" onSubmit={createFolder}><input required maxLength={80} value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} placeholder="New folder name"/><button className="primary" type="submit"><Plus size={16}/> Add folder</button></form><div className="folder-grid">{folders.map((f) => <div className="folder-card" key={f.id}><div className="folder-icon"><Folder size={22}/></div><h3>{f.name}</h3><p>{f.article_count || 0} articles</p></div>)}</div>{!folders.length && <Empty icon={<Folder size={24}/>} title="No folders yet" body="Create folders here or use swipe-right on a news card to file an article."/>}</section>}
        {page === 'admin' && me.role === 'admin' && <section className="content-section"><div className="section-heading"><div><div className="eyebrow">ADMIN PORTAL</div><h1>User management</h1><p className="muted">Create accounts, change usernames, reset passwords, deactivate or delete users.</p></div><button className="primary" onClick={() => { setEditingUser(null); setUserForm({ username: '', password: '', role: 'user', is_active: true }); setShowUserForm(true); }}><Plus size={16}/> Add user</button></div><div className="admin-warning"><ShieldCheck size={18}/><span>Passwords are never displayed. To change a user's password, enter a new one in the edit form. Passwords must be at least 14 characters.</span></div>{showUserForm && <form className="panel stack" onSubmit={saveUser}><div className="form-heading"><h3>{editingUser ? `Edit ${editingUser.username}` : 'Create user'}</h3><button type="button" className="icon-button" onClick={() => { setShowUserForm(false); setEditingUser(null); }}><X size={18}/></button></div><label>Username<input required minLength={3} maxLength={32} pattern="[A-Za-z0-9._-]+" value={userForm.username} onChange={(e) => setUserForm({ ...userForm, username: e.target.value })}/><small className="muted">3–32 letters, numbers, dots, underscores or hyphens.</small></label><label>{editingUser ? 'New password (leave blank to keep current)' : 'Initial password'}<input type="password" minLength={14} required={!editingUser} autoComplete="new-password" value={userForm.password} onChange={(e) => setUserForm({ ...userForm, password: e.target.value })} placeholder="At least 14 characters"/></label><label>Role<select value={userForm.role} onChange={(e) => setUserForm({ ...userForm, role: e.target.value })}><option value="user">User</option><option value="admin">Administrator</option></select></label>{editingUser && <label className="checkbox-label"><input type="checkbox" checked={userForm.is_active} onChange={(e) => setUserForm({ ...userForm, is_active: e.target.checked })}/> Account active</label>}<div className="row-actions"><button className="secondary" type="button" onClick={() => { setShowUserForm(false); setEditingUser(null); }}>Cancel</button><button className="primary" type="submit">{editingUser ? 'Save changes' : 'Create account'}</button></div></form>}<div className="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last login</th><th>Actions</th></tr></thead><tbody>{users.map((u) => <tr key={u.id}><td><div className="table-user"><span className="avatar"><CircleUserRound size={17}/></span><span><b>{u.username}</b><small>{u.username === me.username ? 'You' : `Added ${prettyDate(u.created_at)}`}</small></span></div></td><td><span className="role-pill">{u.role}</span></td><td><span className={`status-pill ${u.is_active ? 'enabled' : 'disabled'}`}>{u.is_active ? 'Active' : 'Inactive'}</span></td><td>{prettyDate(u.last_login_at) || 'Never'}</td><td><div className="table-actions"><button className="secondary small-button" onClick={() => editUser(u)}>Edit</button>{u.id !== me.id && <button className="icon-button danger" title={`Delete ${u.username}`} onClick={() => void deleteUser(u)}><Trash2 size={16}/></button>}</div></td></tr>)}</tbody></table>{!users.length && <p className="muted padded">No users found.</p>}</div></section>}
        {page === 'settings' && <section className="content-section"><div className="section-heading"><div><h1>Settings</h1><p className="muted">Tune MyNews to your reading style.</p></div></div><div className="settings-grid"><div className="panel"><div className="setting-title"><Sun size={19}/><div><h3>Appearance</h3><p className="muted">Choose how MyNews looks.</p></div></div><label>Theme<select value={theme} onChange={(e) => setTheme(e.target.value as typeof theme)}><option value="system">Match device</option><option value="light">Light</option><option value="dark">Dark</option></select></label><label className="checkbox-label"><input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)}/> Compact news list</label><label>Article text size <b>{textSize}px</b><input type="range" min="14" max="21" value={textSize} onChange={(e) => setTextSize(Number(e.target.value))}/></label></div><div className="panel"><div className="setting-title"><Activity size={19}/><div><h3>API budget</h3><p className="muted">Shared daily application limit.</p></div></div><div className="quota-value large">{usage?.used ?? '—'} <span>/ {usage?.cap ?? '—'} credits used</span></div><div className="progress"><span style={{ width: `${usage ? Math.min(100, usage.used / Math.max(1, usage.cap) * 100) : 0}%` }}/></div><p className="muted small-text">{usage?.remaining ?? '—'} credits remain today. News requests are manual; no scheduled polling is enabled.</p></div><div className="panel"><div className="setting-title"><Database size={19}/><div><h3>Data & privacy</h3><p className="muted">Your preferences sync to the server.</p></div></div><p className="small-text">Each account has isolated queries, folders, notes and article state. Saved article metadata is available when cached; original publisher pages may still require internet access.</p><button className="secondary" onClick={() => void loadBase()}><RefreshCw size={16}/> Refresh account data</button></div><div className="panel"><div className="setting-title"><FileText size={19}/><div><h3>About MyNews</h3><p className="muted">Version 0.1 · Initial scaffold</p></div></div><p className="small-text">Query builder, news dashboard, bookmarks, notes and offline sync are being implemented in stages. Swipe left skips the current feed item; swipe right opens the folder picker.</p></div></div></section>}
      </div><footer className="footer"><span>MyNews <span className="dot">·</span> Your rules, your news.</span><span><Cloud size={14}/> {usage ? `${usage.remaining} API credits remaining` : 'Checking usage'}</span></footer>
    </main>
    {previewArticle && (
      <div
        className="modal-backdrop"
        role="presentation"
        onMouseDown={(e) => { if (e.target === e.currentTarget) setPreviewArticle(null); }}
      >
        <section className="modal reader-modal" role="dialog" aria-modal="true" aria-labelledby="preview-modal-title">
          <div className="form-heading">
            <div className="reader-meta">
              <span className="source-badge">{previewArticle.source_name || extractDomain(previewArticle) || 'News source'}</span>
              <span className="dot">·</span>
              <span>{prettyDate(previewArticle.published_at)}</span>
            </div>
            <button className="icon-button" onClick={() => setPreviewArticle(null)}><X size={18}/></button>
          </div>

          {previewArticle.image_url && (
            <div className="reader-modal-hero">
              <img
                src={previewArticle.image_url}
                alt={previewArticle.title}
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
            </div>
          )}

          <h2 id="preview-modal-title" className="reader-modal-title">{previewArticle.title}</h2>

          <div className="reader-modal-content">
            {previewArticle.description ? (
              <p className="reader-modal-description">{previewArticle.description}</p>
            ) : (
              <p className="muted">No description provided for this article.</p>
            )}
          </div>

          <div className="reader-modal-footer">
            <a
              className="primary link-button"
              href={previewArticle.url}
              target="_blank"
              rel="noreferrer"
              onClick={() => {
                void articleState(previewArticle, { is_read: true });
              }}
            >
              <ExternalLink size={16}/> Open article in browser
            </a>
            <button
              className="secondary"
              onClick={() => {
                setFolderArticle(previewArticle);
              }}
            >
              <Folder size={15}/> Save to folder
            </button>
            <button
              className="secondary danger-hover"
              onClick={() => {
                void excludeSource(previewArticle);
                setPreviewArticle(null);
              }}
              title={`Exclude ${extractDomain(previewArticle)} from this monitoring list`}
            >
              <Ban size={15}/> Exclude source ({extractDomain(previewArticle) || 'source'})
            </button>
            <button
              className="secondary"
              onClick={async () => {
                try { await navigator.clipboard.writeText(previewArticle.url); setMessage('Article link copied.'); }
                catch { window.prompt('Copy article link', previewArticle.url); }
              }}
            >
              <Bookmark size={15}/> Copy link
            </button>
          </div>
        </section>
      </div>
    )}
    {folderArticle && <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setFolderArticle(null); }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="folder-modal-title"><div className="form-heading"><div><div className="eyebrow">SAVE ARTICLE</div><h2 id="folder-modal-title">Choose a folder</h2></div><button className="icon-button" onClick={() => setFolderArticle(null)}><X size={18}/></button></div><p className="muted">{folderArticle.title}</p>{folders.map((f) => <button className="folder-choice" key={f.id} onClick={() => void fileArticle(f.id)}><Folder size={18}/><span>{f.name}</span><ChevronDown size={15}/></button>)}{!folders.length && <p className="muted">Create a folder first from the Folders screen.</p>}<button className="secondary full" onClick={() => { setFolderArticle(null); setPage('folders'); }}>Manage folders</button></section></div>}
  </div>;
}
function Brand() { return <div className="brand"><span className="brand-mark"><Newspaper size={20}/></span><span>My<span>News</span></span></div>; }
function Message({ error, notice }: { error: string; notice: string }) { if (!error && !notice) return null; return <div className={`message ${error ? 'error' : 'notice'}`}><span>{error || notice}</span></div>; }
function Stat({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string | number; detail: string }) { return <div className="stat-card"><div className="stat-top"><span className="stat-icon">{icon}</span><span>{label}</span></div><div className="stat-value">{value}</div><div className="stat-detail">{detail}</div></div>; }
function Empty({ icon, title, body, action }: { icon: React.ReactNode; title: string; body: string; action?: React.ReactNode }) { return <div className="empty-panel"><span className="empty-icon">{icon}</span><h3>{title}</h3><p>{body}</p>{action}</div>; }
function ArticleCard({
  article,
  compact,
  onSave,
  onRead,
  onSkip,
  onPreview,
  onExcludeSource
}: {
  article: Article;
  compact: boolean;
  onSave: () => void;
  onRead: () => void;
  onSkip: () => void;
  onPreview: () => void;
  onExcludeSource?: () => void;
}) {
  const [touchStart, setTouchStart] = useState<number | null>(null);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const handleTouchEnd = () => {
    if (swipeOffset < -85) onSkip();
    else if (swipeOffset > 85) onSave();
    setSwipeOffset(0);
    setTouchStart(null);
  };
  const domain = extractDomain(article);

  return (
    <article
      className={`article-card ${compact ? 'compact-card' : ''} ${article.is_read ? 'is-read' : ''}`}
      onTouchStart={(e) => setTouchStart(e.touches[0]?.clientX ?? null)}
      onTouchMove={(e) => {
        if (touchStart !== null)
          setSwipeOffset(Math.max(-130, Math.min(130, (e.touches[0]?.clientX ?? touchStart) - touchStart)));
      }}
      onTouchEnd={handleTouchEnd}
      style={{ transform: `translateX(${swipeOffset * 0.22}px)` }}
    >
      <div className="swipe-hint left"><X size={16}/> Skip</div>
      <div className="swipe-hint right"><Folder size={16}/> Folder</div>
      {article.image_url && !compact && (
        <div
          className="article-image-wrap clickable"
          onClick={onPreview}
          title="Click to preview article description"
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onPreview(); }}
        >
          <img
            src={article.image_url}
            alt=""
            loading="lazy"
            onError={(e) => { e.currentTarget.style.display = 'none'; }}
          />
        </div>
      )}
      <div className="article-body">
        <div className="article-meta">
          <span className="source-dot"/>
          {article.source_name || domain || 'News source'}
          <span className="dot">·</span>
          {prettyDate(article.published_at)}
          {article.is_read ? <span className="read-label"><Check size={12}/> Read</span> : null}
        </div>
        <button
          type="button"
          className="article-title article-title-button"
          onClick={onPreview}
          title="Click to view details and open article"
        >
          {article.title}
        </button>
        {article.description && <p className="article-description article-clickable-desc" onClick={onPreview} title="Click to view full preview">{article.description}</p>}
        <div className="match-reason"><Search size={13}/>{article.match_reason || 'Matched your monitoring list'}</div>
        <div className="article-actions">
          <button className="text-action" onClick={onPreview} title="Read full description and preview"><Eye size={15}/> Read</button>
          <button className="text-action" onClick={onSave}><Folder size={15}/> File</button>
          <button className="text-action" onClick={onRead}>
            {article.is_read ? <Check size={15}/> : <FileText size={15}/>} {article.is_read ? 'Mark unread' : 'Mark read'}
          </button>
          {onExcludeSource && (
            <button
              className="text-action danger-hover"
              onClick={onExcludeSource}
              title={`Exclude source "${domain || 'source'}" from this monitoring query`}
            >
              <Ban size={15}/> Exclude source
            </button>
          )}
          <button
            className="text-action"
            onClick={async () => {
              try { await navigator.clipboard.writeText(article.url); }
              catch { window.prompt('Copy article link', article.url); }
            }}
          >
            <Bookmark size={15}/> Copy link
          </button>
          <button className="text-action skip-action" onClick={onSkip}><X size={15}/> Skip</button>
        </div>
      </div>
    </article>
  );
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
