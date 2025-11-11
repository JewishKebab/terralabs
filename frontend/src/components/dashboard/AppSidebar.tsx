// src/components/dashboard/AppSidebar.tsx
import { useEffect, useMemo, useState } from "react";
import {
  Home,
  Server,
  Settings,
  LogOut,
  User,
  UserCircle,
  Monitor,
  GraduationCap,
  BadgeInfo,
} from "lucide-react";
import { NavLink, useNavigate } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import axios, { AxiosHeaders } from "axios";

type Me = {
  id: number;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
};

const navItems = [
  { title: "Dashboard", url: "/dashboard", icon: Home },
  { title: "Template VM", url: "/template-vm", icon: Monitor },
  { title: "Running Labs", url: "/labs", icon: Server },
];

export function AppSidebar() {
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";
  const navigate = useNavigate();
  const { toast } = useToast();

  const [user, setUser] = useState<Me | null>(null);

  // AAD tags saved by Auth flow
  const [role, setRole] = useState<string | null>(null);
  const [course, setCourse] = useState<string | null>(null);
  const [section, setSection] = useState<string | null>(null);

  const api = useMemo(() => {
    const i = axios.create({
      baseURL: "http://localhost:5000",
      headers: new AxiosHeaders({ "Content-Type": "application/json" }),
      timeout: 15000,
    });
    i.interceptors.request.use((config) => {
      config.headers = AxiosHeaders.from(config.headers);
      const t = localStorage.getItem("auth_token");
      if (t) (config.headers as AxiosHeaders).set("Authorization", `Bearer ${t}`);
      return config;
    });
    return i;
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await api.get("/api/me");
        if (mounted) setUser(res.data as Me);
      } catch {
        navigate("/auth", { replace: true });
      }
    })();
    return () => {
      mounted = false;
    };
  }, [api, navigate]);

  useEffect(() => {
    const r = (localStorage.getItem("aad_role") || "").toLowerCase();
    setRole(r);
    setCourse(localStorage.getItem("aad_course"));
    setSection(localStorage.getItem("aad_section"));
  }, []);

  const handleLogout = async () => {
    localStorage.removeItem("auth_token");
    Object.keys(localStorage)
      .filter((k) => k.startsWith("template_vm_session"))
      .forEach((k) => localStorage.removeItem(k));
    localStorage.removeItem("aad_role");
    localStorage.removeItem("aad_course");
    localStorage.removeItem("aad_section");
    localStorage.removeItem("aad_groups");
    toast({ title: "Logged Out", description: "You have been successfully logged out." });
    navigate("/auth", { replace: true });
  };

  const displayName =
    [user?.first_name, user?.last_name].filter(Boolean).join(" ") ||
    user?.email ||
    "User";

  const roleLabel = role ? role.charAt(0).toUpperCase() + role.slice(1) : null;
  const isAsgard = (role || "").toLowerCase() === "asgard";

  return (
    <Sidebar collapsible="icon">
      <SidebarContent>
        {/* Compact user header */}
        {!isCollapsed && (
          <div className="px-3 pt-3 pb-2 space-y-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="flex items-center gap-2 w-full rounded-md px-2 py-2 hover:bg-sidebar-accent transition-colors"
                  title={displayName}
                >
                  <div className="h-9 w-9 rounded-full bg-gradient-primary flex items-center justify-center shadow-glow shrink-0">
                    <User className="h-4 w-4 text-primary-foreground" />
                  </div>
                  <div className="min-w-0 text-left">
                    <p className="text-sm font-medium text-sidebar-foreground truncate">
                      Welcome, {displayName}
                    </p>
                    {roleLabel ? (
                      <p className="text-[11px] leading-4 text-sidebar-foreground/70 truncate">
                        {roleLabel} — {isAsgard ? "full access" : "signed in"}
                      </p>
                    ) : null}
                  </div>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuLabel>My Account</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                  <UserCircle className="mr-2 h-4 w-4" />
                  <span>Profile</span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                  <Settings className="mr-2 h-4 w-4" />
                  <span>Settings</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleLogout}>
                  <LogOut className="mr-2 h-4 w-4" />
                  <span>Log out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {(role || course || section) && (
              <div className="rounded-md border bg-sidebar-accent/30 px-2.5 py-2 text-[11.5px] leading-5 text-sidebar-foreground space-y-1">
                {roleLabel && (
                  <div className="flex items-center gap-1.5">
                    <BadgeInfo className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">
                      Role: <strong>{roleLabel}</strong>
                    </span>
                  </div>
                )}
                {!isAsgard && (course || section) && (
                  <div className="flex items-center gap-1.5">
                    <GraduationCap className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">
                      {course ? <>Course: <strong>{course}</strong></> : null}
                      {section ? <> • Section: <strong>{section}</strong></> : null}
                    </span>
                  </div>
                )}
              </div>
            )}

            <Separator className="bg-sidebar-border" />
          </div>
        )}

        {/* Navigation */}
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild>
                    <NavLink
                      to={item.url}
                      className={({ isActive }) =>
                        [
                          "flex items-center gap-2 rounded-md px-2 py-2 transition-colors",
                          isActive
                            ? "bg-sidebar-accent text-sidebar-accent-foreground"
                            : "hover:bg-sidebar-accent",
                        ].join(" ")
                      }
                    >
                      <item.icon className="h-4 w-4 shrink-0" />
                      {!isCollapsed && <span className="truncate">{item.title}</span>}
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

export default AppSidebar;
