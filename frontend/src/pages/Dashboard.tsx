import { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/dashboard/AppSidebar";
import { ProvisioningStepper } from "@/components/dashboard/ProvisioningStepper";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import logo from "@/assets/terralabs-logo.png";
import axios, { AxiosInstance, AxiosHeaders } from "axios";

const API_BASE_URL = "http://localhost:5000";

const Dashboard = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);

  // axios instance with correct header typing
  const api: AxiosInstance = useMemo(() => {
    const instance = axios.create({
      baseURL: API_BASE_URL,
      headers: new AxiosHeaders({ "Content-Type": "application/json" }),
      timeout: 15000,
      // withCredentials: true, // only if you switch to cookie auth
    });

    instance.interceptors.request.use((config) => {
      const token = localStorage.getItem("auth_token");
      if (token) {
        // ensure headers is AxiosHeaders, then set safely
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

  // auth gate: require token; optionally you can ping a protected endpoint
  useEffect(() => {
    const token = localStorage.getItem("auth_token");
    if (!token) {
      navigate("/auth");
      return;
    }
    setLoading(false);
  }, [navigate]);

  const handleLogout = async () => {
    localStorage.removeItem("auth_token");
    toast({ title: "Logged Out", description: "You have been successfully logged out." });
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
          <header className="h-13 border-b bg-card flex items-center justify-between px-6 shadow-sm">
            <div className="flex items-center gap-4">
              <SidebarTrigger />
              <div className="py-2 rounded-md">
                <img src={logo} alt="TerraLabs" className="h-12" />
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
                <h1 className="text-3xl font-bold mb-2">Create Lab</h1>
                <p className="text-muted-foreground">
                  Follow the steps below to provision your lab using Terraform
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
