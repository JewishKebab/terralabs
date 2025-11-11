// src/pages/Dashboard.tsx
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/dashboard/AppSidebar";
import { ProvisioningStepper } from "@/components/dashboard/ProvisioningStepper";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import logo from "@/assets/terralabs-logo.png";
import axios, { AxiosInstance, AxiosHeaders } from "axios";
import { useFullLogout } from "@/hooks/useFullLogout";

const API_BASE_URL = "http://localhost:5000";

function normalizeCourse(c?: string | null): "tichnut"|"cyber"|"devops"|"dc"|null {
  if (!c) return null;
  const k = c.trim().toLowerCase();
  if (k.startsWith("tichnut")) return "tichnut";
  if (k.startsWith("cyber")) return "cyber";
  if (k.includes("devops")) return "devops";
  if (k === "dc" || k.includes("data center") || k.includes("datacenter")) return "dc";
  return null;
}

function allowedForSegel(courseNorm: ReturnType<typeof normalizeCourse>): string[] {
  switch (courseNorm) {
    case "tichnut":
      return ["tichnut-a", "tichnut-b", "tichnut-c", "tichnut-d"];
    case "cyber":
      return ["cyber-a", "cyber-b"];
    case "devops":
      return ["devops"];
    case "dc":
      return ["dc"];
    default:
      return []; // unknown => nothing
  }
}

const Dashboard = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const logout = useFullLogout();

  // derive AAD tags
  const role = (localStorage.getItem("aad_role") || "").toLowerCase();     // "asgard" | "segel" | "student" | "administrator" | ""
  const rawCourse = localStorage.getItem("aad_course");                    // e.g. "Tichnut", "Cyber", "DevOps", "DC"
  const courseNorm = normalizeCourse(rawCourse);

  // compute lock list
  const lockToCourses: string[] | undefined = useMemo(() => {
    if (role === "asgard" || role === "administrator") return undefined; // full access
    if (role === "segel") return allowedForSegel(courseNorm);
    return []; // students (shouldn’t be here) or unknown role
  }, [role, courseNorm]);

  // axios instance
  const api: AxiosInstance = useMemo(() => {
    const instance = axios.create({
      baseURL: API_BASE_URL,
      headers: new AxiosHeaders({ "Content-Type": "application/json" }),
      timeout: 15000,
    });
    instance.interceptors.request.use((config) => {
      const token = localStorage.getItem("auth_token");
      if (token) {
        config.headers = AxiosHeaders.from(config.headers);
        (config.headers as AxiosHeaders).set("Authorization", `Bearer ${token}`);
      }
      return config;
    });
    instance.interceptors.response.use(
      (res) => res,
      (err) => {
        if (err?.response?.status === 401) {
          localStorage.removeItem("auth_token");
          navigate("/auth");
        }
        return Promise.reject(err);
      }
    );
    return instance;
  }, [navigate]);

  // auth/role gate
  useEffect(() => {
    const token = localStorage.getItem("auth_token");
    if (!token) {
      navigate("/auth");
      return;
    }
    // Students should not see Dashboard at all
    if (role === "student") {
      navigate("/labs", { replace: true });
      return;
    }
    setLoading(false);
  }, [navigate, role]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <div className="bg-[#1a1a1a] px-6 py-3 rounded-lg mx-auto mb-4 animate-pulse inline-block">
            <img src={logo} alt="TerraLabs" className="h-8" />
          </div>
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full bg-background">
        <AppSidebar />
        <div className="flex-1 flex flex-col">
          {/* Header (h-16 like others) */}
          <header className="h-16 border-b bg-card flex items-center justify-between px-6 shadow-sm">
            <div className="flex items-center gap-4">
              <SidebarTrigger />
              <div className="py-2 rounded-md">
                <img src={logo} alt="TerraLabs" className="h-12" />
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                toast({ title: "Logging out…" });
                await logout();
              }}
            >
              <LogOut className="mr-2 h-4 w-4" />
              Logout
            </Button>
          </header>

          {/* Main Content */}
          <main className="flex-1 p-6 overflow-auto">
            <div className="max-w-5xl mx-auto">
              <div className="mb-8">
                <h1 className="text-3xl font-bold mb-2">Create Lab</h1>
                <p className="text-muted-foreground">
                  Follow the steps below to provision your lab using Terraform
                </p>
              </div>

              {/* IMPORTANT: lockToCourses controls what the user can choose */}
              <ProvisioningStepper lockToCourses={lockToCourses} />
            </div>
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
};

export default Dashboard;
