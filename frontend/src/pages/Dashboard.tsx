import { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/dashboard/AppSidebar";
import { ProvisioningStepper } from "@/components/dashboard/ProvisioningStepper";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import logo from "@/assets/terralabs-logo.png";
import axios, { AxiosInstance } from "axios";

const API_BASE_URL = "http://localhost:5000"; // your Flask API

const Dashboard = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);

  // Single axios instance with auth header + 401 handling
  const api: AxiosInstance = useMemo(() => {
    const instance = axios.create({
      baseURL: API_BASE_URL,
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
      // withCredentials: true, // enable only if you switch to cookie auth
    });

    instance.interceptors.request.use((config) => {
      const token = localStorage.getItem("auth_token");
      if (token) {
        config.headers = config.headers ?? {};
        (config.headers as Record<string, string>)["Authorization"] = `Bearer ${token}`;
      }
      return config;
    });

    instance.interceptors.response.use(
      (res) => res,
      (err) => {
        const status = err?.response?.status;
        if (status === 401) {
          // token invalid/expired → force logout
          localStorage.removeItem("auth_token");
          navigate("/auth");
        }
        return Promise.reject(err);
      }
    );

    return instance;
  }, [navigate]);

  // Auth check: require token in localStorage (optionally ping a protected endpoint if you add one)
  useEffect(() => {
    const token = localStorage.getItem("auth_token");
    if (!token) {
      navigate("/auth");
      return;
    }
    // If you later add a protected endpoint, uncomment to verify server-side:
    // api.get("/api/me").then(() => setLoading(false)).catch(() => navigate("/auth"));
    setLoading(false);
  }, [navigate, api]);

  const handleLogout = async () => {
    localStorage.removeItem("auth_token");
    toast({
      title: "Logged Out",
      description: "You have been successfully logged out.",
    });
    navigate("/auth");
  };

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
          {/* Header */}
          <header className="h-16 border-b bg-card flex items-center justify-between px-6 shadow-sm">
            <div className="flex items-center gap-4">
              <SidebarTrigger />
              <div className="bg-[#1a1a1a] px-4 py-2 rounded-md">
                <img src={logo} alt="TerraLabs" className="h-6" />
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={handleLogout}>
              <LogOut className="mr-2 h-4 w-4" />
              Logout
            </Button>
          </header>

          {/* Main Content */}
          <main className="flex-1 p-6 overflow-auto">
            <div className="max-w-5xl mx-auto">
              <div className="mb-8">
                <h1 className="text-3xl font-bold mb-2">Create Cloud Resources</h1>
                <p className="text-muted-foreground">
                  Follow the steps below to provision your infrastructure using Terraform
                </p>
              </div>

              <ProvisioningStepper />
            </div>
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
};

export default Dashboard;
