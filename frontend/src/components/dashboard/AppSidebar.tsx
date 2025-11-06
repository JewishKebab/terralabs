import { useEffect, useMemo, useState } from "react";
import { Home, Server, Settings, LogOut, User, UserCircle } from "lucide-react";
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
  { title: "Running Labs", url: "/labs", icon: Server },
];

export function AppSidebar() {
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";
  const navigate = useNavigate();
  const { toast } = useToast();

  const [user, setUser] = useState<Me | null>(null);

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
        // Not logged in or token invalid — bounce to auth
        navigate("/auth", { replace: true });
      }
    })();
    return () => {
      mounted = false;
    };
  }, [api, navigate]);

  const handleLogout = async () => {
    // Clear JWT and go to /auth
    localStorage.removeItem("auth_token");
    toast({ title: "Logged Out", description: "You have been successfully logged out." });
    navigate("/auth", { replace: true });
  };

  const displayName =
    [user?.first_name, user?.last_name].filter(Boolean).join(" ") || user?.email || "User";

  return (
    <Sidebar collapsible="icon">
      <SidebarContent>
        {/* User Welcome Section */}
        {!isCollapsed && (
          <div className="p-4">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-3 mb-2 w-full hover:bg-sidebar-accent rounded-lg p-2 transition-colors">
                  <div className="h-10 w-10 rounded-full bg-gradient-primary flex items-center justify-center shadow-glow">
                    <User className="h-5 w-5 text-primary-foreground" />
                  </div>
                  <div className="flex-1 overflow-hidden text-left">
                    <p className="text-sm font-medium text-sidebar-foreground">Welcome</p>
                    <p className="text-xs text-sidebar-foreground/70 truncate">{displayName}</p>
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
                          isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent",
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
