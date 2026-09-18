import { useQuery } from '@tanstack/react-query';
import { Activity, BarChart3, FolderOpen, Layers, LogOut, ScrollText } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import logo from '../../../public/logo.svg';
import { api } from '../lib/api';
import { useSignOut, useMe } from '../lib/auth';
import { Button } from './ui/button';
import { Separator } from './ui/separator';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from './ui/sidebar';

/** A nav item's sub-menu: `activeKey` picks the highlighted child so the parent is not highlighted alongside it. */
type NavSub = { Menu: (props: { active?: string }) => ReactNode; activeKey: (pathname: string) => string | undefined };
type NavItem = { to: string; label: string; icon: typeof FolderOpen; roots?: string[]; sub?: NavSub };

const projectSlug = (pathname: string): string | undefined => /^\/projects\/([^/]+)/.exec(pathname)?.[1];

const ProjectsSub = ({ active }: { active?: string }) => {
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects.list });
  if (!projects.data?.length) return null;
  return (
    <SidebarMenuSub>
      {projects.data.map((project) => (
        <SidebarMenuSubItem key={project.id}>
          <SidebarMenuSubButton asChild isActive={project.slug === active}>
            <NavLink to={`/projects/${project.slug}`}>
              <span>{project.name}</span>
            </NavLink>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ))}
    </SidebarMenuSub>
  );
};

const NAV: NavItem[] = [
  { to: '/', label: 'Projects', icon: FolderOpen, roots: ['/projects', '/resources'], sub: { Menu: ProjectsSub, activeKey: projectSlug } },
  { to: '/layers', label: 'Layers', icon: Layers },
  { to: '/queue', label: 'Queue', icon: Activity },
  { to: '/analytics', label: 'Cost', icon: BarChart3 },
  { to: '/audit', label: 'Audit Log', icon: ScrollText },
];

const isActive = (pathname: string, item: NavItem): boolean =>
  pathname === item.to || [item.to, ...(item.roots ?? [])].some((root) => root !== '/' && pathname.startsWith(root));

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

const UserFooter = () => {
  const me = useMe();
  const signOut = useSignOut();
  const { state } = useSidebar();
  if (!me.user) return null;
  return (
    <SidebarFooter>
      <div className="flex items-center gap-2 rounded-md p-1 group-data-[collapsible=icon]:justify-center">
        {me.user.avatarUrl ? (
          <img src={me.user.avatarUrl} alt="" className="size-8 shrink-0 rounded-full" referrerPolicy="no-referrer" />
        ) : (
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-xs font-medium">{initials(me.user.name)}</div>
        )}
        {state === 'expanded' ? (
          <>
            <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{me.user.name}</span>
              <span className="truncate text-xs text-sidebar-foreground/70">{me.user.email}</span>
            </div>
            <Button variant="ghost" size="icon" className="size-8 shrink-0" title="Sign out" onClick={() => void signOut()}>
              <LogOut className="size-4" />
            </Button>
          </>
        ) : null}
      </div>
    </SidebarFooter>
  );
};

const AppSidebar = () => {
  const { pathname } = useLocation();
  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <NavLink to="/">
                <img src={logo} alt="" className="size-8 shrink-0" />
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">opendeepl</span>
                  <span className="truncate text-xs text-sidebar-foreground/70">OSS AI-powered translations</span>
                </div>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Platform</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map((item) => {
                const activeSub = item.sub?.activeKey(pathname);
                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild isActive={isActive(pathname, item) && !activeSub} tooltip={item.label}>
                      <NavLink to={item.to}>
                        <item.icon />
                        <span>{item.label}</span>
                      </NavLink>
                    </SidebarMenuButton>
                    {item.sub ? <item.sub.Menu active={activeSub} /> : null}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <UserFooter />
      <SidebarRail />
    </Sidebar>
  );
};

export const Layout = () => {
  const { pathname } = useLocation();
  const section = NAV.find((item) => isActive(pathname, item));
  return (
    <SidebarProvider className="h-svh">
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <span className="text-sm font-medium">{section?.label}</span>
        </header>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-6 md:px-8">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
};

export const PageHeader = ({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) => (
  <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
    <div className="min-w-0">
      <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
      {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
    </div>
    {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
  </div>
);

export const Empty = ({ children }: { children: ReactNode }) => (
  <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">{children}</div>
);

export const ErrorNote = ({ error }: { error: unknown }) =>
  error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error instanceof Error ? error.message : String(error)}</div> : null;
