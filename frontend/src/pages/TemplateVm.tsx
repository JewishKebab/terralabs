import { useEffect, useMemo, useState } from "react";
import axios, { AxiosHeaders } from "axios";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/dashboard/AppSidebar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  LogOut,
  Eye,
  EyeOff,
  Cloud,
  Cpu,
  RefreshCw,
  Save,
  Trash2,
  Monitor,
  Loader2,
} from "lucide-react";
import Lottie from "lottie-react";
import vmAnim from "@/assets/VM.json";
import logo from "@/assets/terralabs-logo.png";
import { useNavigate } from "react-router-dom";
import { useFullLogout } from "@/hooks/useFullLogout";

type TemplateVm = {
  vm_id: string;
  name?: string;
  resource_group?: string;
  public_ip?: string | null;
  private_ip?: string | null;
  power_state?: string | null;
  provisioning_state?: string | null;
  image_label?: string;
  created_at?: string;
};

type Me = {
  id: number;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
};

const API_BASE = "http://localhost:5000";
const BASE_SESSION_KEY = "template_vm_session";

const VM_SIZES = [
  { label: "Standard_B2s (2 vCPU, 4 GB RAM)", value: "Standard_B2s" },
  { label: "Standard_D2s_v3 (2 vCPU, 8 GB RAM)", value: "Standard_D2s_v3" },
];

const IMAGES = [
  {
    label: "Windows Server 2025",
    id: "/subscriptions/89641046-9c08-41ad-954a-7ff2f2d626f7/resourceGroups/labs-bsmch-prod-labplan-devops-a-rg/providers/Microsoft.Compute/galleries/Labs_Bsmch_Prod_ComputeGallery_DEVOPS/images/Windows-2025-Server-Image",
    version: "0.0.1",
    os: "windows",
  },
  {
    label: "Windows 11 Endpoint",
    id: "/subscriptions/89641046-9c08-41ad-954a-7ff2f2d626f7/resourceGroups/labs-bsmch-prod-labplan-devops-a-rg/providers/Microsoft.Compute/galleries/Labs_Bsmch_Prod_ComputeGallery_DEVOPS/images/Windows11-Endpoint-Image",
    version: "latest",
    os: "windows",
  },
  {
    label: "RHEL 9",
    id: "/subscriptions/89641046-9c08-41ad-954a-7ff2f2d626f7/resourceGroups/Labs-Bsmch-Prod-LabPlan-DEVOPS-A-RG/providers/Microsoft.Compute/galleries/Labs_Bsmch_Prod_ComputeGallery_DEVOPS/images/Red-Hat-Enterprise-Linux-9",
    version: "latest",
    os: "linux",
  },
];

// Sanitize the middle part of the snapshot name
const cleanSnapBase = (s: string) =>
  (s || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .slice(0, 40);

export default function TemplateVmPage() {
  const navigate = useNavigate();
  const logout = useFullLogout(); // 🔹 shared centralized logout
  const { toast } = useToast();

  const [me, setMe] = useState<Me | null>(null);
  const [imageKey, setImageKey] = useState<string>(IMAGES[0].id);
  const [vmSize, setVmSize] = useState<string>("Standard_B2s");
  const [adminUser, setAdminUser] = useState("");
  const [adminPass, setAdminPass] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [snapBase, setSnapBase] = useState("");

  const [active, setActive] = useState<TemplateVm | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [polling, setPolling] = useState(false);
  const [bootLoading, setBootLoading] = useState(true);

  const api = useMemo(() => {
    const i = axios.create({
      baseURL: API_BASE,
      headers: new AxiosHeaders({ "Content-Type": "application/json" }),
    });
    i.interceptors.request.use((config) => {
      config.headers = AxiosHeaders.from(config.headers);
      const t = localStorage.getItem("auth_token");
      if (t) (config.headers as AxiosHeaders).set("Authorization", `Bearer ${t}`);
      return config;
    });
    return i;
  }, []);

  const userSessionKey = useMemo(() => {
    return me?.email ? `${BASE_SESSION_KEY}:${me.email.toLowerCase()}` : BASE_SESSION_KEY;
  }, [me?.email]);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get("/api/me");
        setMe(res.data as Me);
      } catch {
        setMe(null);
      }
    })();
  }, [api]);

  useEffect(() => {
    if (!me?.email) return;

    Object.keys(localStorage)
      .filter((k) => k.startsWith(`${BASE_SESSION_KEY}:`) && k !== userSessionKey)
      .forEach((k) => localStorage.removeItem(k));

    const raw = localStorage.getItem(userSessionKey);
    if (raw) {
      try {
        const obj = JSON.parse(raw) as TemplateVm;
        if (obj?.vm_id) setActive(obj);
      } catch {}
    } else {
      setActive(null);
    }

    (async () => {
      try {
        const res = await api.get("/api/template-vm/status");
        const data = res.data || {};
        if (data.exists === false) {
          setActive(null);
        } else {
          setActive((prev) => ({ ...(prev || {}), ...data }));
        }
      } catch {
      } finally {
        setBootLoading(false);
      }
    })();
  }, [me?.email]);

  useEffect(() => {
    if (active?.vm_id)
      localStorage.setItem(userSessionKey, JSON.stringify(active));
    else localStorage.removeItem(userSessionKey);
  }, [active, userSessionKey]);

  const selectedImage = IMAGES.find((x) => x.id === imageKey)!;

  const pollStatus = async (continuous = false) => {
    setPolling(true);
    try {
      const res = await api.get("/api/template-vm/status");
      const data = res.data || {};
      if (data.exists === false) {
        setActive(null);
        localStorage.removeItem(userSessionKey);
        return;
      }
      setActive((prev) => ({ ...(prev || {}), ...data }));
      if (bootLoading) setBootLoading(false);
    } catch (e: any) {
      const status = e?.response?.status;
      if (status === 404) {
        setActive(null);
        localStorage.removeItem(userSessionKey);
        return;
      }
      toast({
        variant: "destructive",
        title: "Failed to fetch status",
        description: e?.response?.data?.error || e?.message,
      });
    } finally {
      setPolling(false);
      if (continuous) setTimeout(() => pollStatus(true), 4000);
    }
  };

  const createTemplateVm = async () => {
    if (!adminUser || !adminPass) {
      toast({
        variant: "destructive",
        title: "Missing fields",
        description: "Please provide admin username and password.",
      });
      return;
    }

    setCreating(true);
    try {
      const body = {
        image_id: selectedImage.id,
        image_version: selectedImage.version,
        os_type: selectedImage.os,
        vm_size: vmSize,
        admin_username: adminUser,
        admin_password: adminPass,
      };

      const res = await api.post("/api/template-vm/create", body);
      const vm: TemplateVm = {
        vm_id: res.data?.vm_id,
        name: res.data?.name,
        resource_group: res.data?.resource_group,
        public_ip: res.data?.public_ip,
        private_ip: res.data?.private_ip,
        power_state: res.data?.power_state,
        provisioning_state: res.data?.provisioning_state,
        image_label: selectedImage.label,
        created_at: new Date().toISOString(),
      };
      setActive(vm);
      toast({ title: "Template VM creating", description: "This may take a few minutes…" });

      setBootLoading(true);
      setTimeout(() => pollStatus(true), 2000);
    } catch (e: any) {
      toast({
        variant: "destructive",
        title: "Failed to create template VM",
        description: e?.response?.data?.error || e?.message,
      });
    } finally {
      setCreating(false);
    }
  };

  const fullSnapshotName = useMemo(() => {
    const mid = cleanSnapBase(snapBase) || "Snapshot";
    return `Projects-${mid}-Snapshot`;
  }, [snapBase]);

  const publishSnapshot = async () => {
    if (!active?.vm_id) return;
    setBusy(true);
    try {
      await api.post("/api/template-vm/snapshot", {
        snapshot_name: fullSnapshotName,
      });
      toast({
        title: "Snapshot published",
        description: "VM snapshot saved and template VM deleted.",
      });
      setActive(null);
      setSnapBase("");
      localStorage.removeItem(userSessionKey);
    } catch (e: any) {
      toast({
        variant: "destructive",
        title: "Failed to publish snapshot",
        description: e?.response?.data?.error || e?.message,
      });
    } finally {
      setBusy(false);
    }
  };

  const discardVm = async () => {
    if (!active?.vm_id) return;
    setBusy(true);
    try {
      await api.post("/api/template-vm/discard", {});
      toast({ title: "Template VM deleted" });
      setActive(null);
      localStorage.removeItem(userSessionKey);
    } catch (e: any) {
      toast({
        variant: "destructive",
        title: "Failed to delete VM",
        description: e?.response?.data?.error || e?.message,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full bg-background">
        <AppSidebar />

        <div className="flex-1 flex flex-col">
          {/* Header (matches Dashboard placement/size) */}
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

          {/* Content */}
          <main className="flex-1 p-6 overflow-auto">
            <div className="max-w-6xl mx-auto space-y-6">
              {/* Boot-time loading */}
              {bootLoading && (
                <Card className="shadow-elegant">
                  <CardContent className="py-10">
                    <div className="flex flex-col items-center justify-center gap-4">
                      <Loader2 className="h-6 w-6 animate-spin" />
                      <p className="text-sm text-muted-foreground">
                        Preparing your Template VM status… hang tight.
                      </p>
                    </div>
                  </CardContent>
                </Card>
              )}

              {!bootLoading && !active ? (
                <Card className="shadow-elegant">
                  <CardHeader>
                    <CardTitle>Create a Template VM</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <Label>Base Image</Label>
                          <Select value={imageKey} onValueChange={setImageKey}>
                            <SelectTrigger>
                              <SelectValue placeholder="Choose image" />
                            </SelectTrigger>
                            <SelectContent>
                              {IMAGES.map((img) => (
                                <SelectItem key={img.id} value={img.id}>
                                  {img.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-2">
                          <Label>Size</Label>
                          <Select value={vmSize} onValueChange={setVmSize}>
                            <SelectTrigger>
                              <SelectValue placeholder="Select size" />
                            </SelectTrigger>
                            <SelectContent>
                              {VM_SIZES.map((s) => (
                                <SelectItem key={s.value} value={s.value}>
                                  {s.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-2">
                          <Label>Admin Username</Label>
                          <Input
                            value={adminUser}
                            onChange={(e) => setAdminUser(e.target.value)}
                          />
                        </div>

                        <div className="space-y-2">
                          <Label>Admin Password</Label>
                          <div className="flex gap-2">
                            <Input
                              type={showPass ? "text" : "password"}
                              value={adminPass}
                              onChange={(e) => setAdminPass(e.target.value)}
                            />
                            <Button
                              variant="outline"
                              type="button"
                              onClick={() => setShowPass((s) => !s)}
                            >
                              {showPass ? (
                                <EyeOff className="h-4 w-4" />
                              ) : (
                                <Eye className="h-4 w-4" />
                              )}
                            </Button>
                          </div>
                        </div>

                        <div className="flex justify-center pt-3">
                          <Button
                            onClick={createTemplateVm}
                            disabled={creating}
                            className="bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-md shadow-violet-500/30 hover:shadow-violet-500/50 hover:from-violet-500 hover:to-indigo-500 transition-all px-5 py-2 rounded-xl font-medium"
                          >
                            {creating ? (
                              "Creating… This may take a moment"
                            ) : (
                              <span className="inline-flex items-center gap-2">
                                <Monitor className="h-4 w-4" />
                                Create Template VM
                              </span>
                            )}
                          </Button>
                        </div>
                      </div>

                      <div className="flex justify-center mr-5">
                        <div className="w-72 md:w-80">
                          <Lottie animationData={vmAnim} loop autoplay />
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ) : null}

              {!bootLoading && active ? (
                <Card className="shadow-elegant">
                  <CardHeader>
                    <CardTitle>Template VM Status</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {active.provisioning_state &&
                      active.provisioning_state.toLowerCase() !== "succeeded" && (
                        <div className="mb-4 rounded-lg border bg-muted/40 px-4 py-2 text-sm flex items-center gap-2">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Provisioning your VM… this may take a little while.
                        </div>
                      )}

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
                      <div className="space-y-3">
                        <div className="text-sm">
                          <div className="mb-2">
                            <span className="font-semibold">Image:</span> {active.image_label}
                          </div>
                          <div className="mb-2">
                            <span className="font-semibold">VM ID:</span> {active.vm_id}
                          </div>
                          <div className="mb-2">
                            <span className="font-semibold">Name:</span> {active.name || "-"}
                          </div>
                          <div className="mb-2">
                            <span className="font-semibold">Private IP:</span>{" "}
                            {active.private_ip || "-"}
                          </div>
                          <div className="mb-2">
                            <span className="font-semibold">Public IP:</span>{" "}
                            {active.public_ip || "-"}
                          </div>
                          <div className="mb-2 inline-flex items-center gap-2">
                            <Cpu className="h-4 w-4" />
                            <Badge variant="outline">
                              {(active.power_state || "unknown").toUpperCase()}
                            </Badge>
                          </div>
                          <div className="mb-2 inline-flex items-center gap-2">
                            <Cloud className="h-4 w-4" />
                            <Badge>
                              {(active.provisioning_state || "unknown").toUpperCase()}
                            </Badge>
                          </div>
                        </div>

                        <div className="space-y-2 pt-2">
                          <Label>Snapshot Name</Label>
                          <Input
                            placeholder="e.g. MyCustomImage"
                            value={snapBase}
                            onChange={(e) => setSnapBase(e.target.value)}
                          />
                          <p className="text-xs text-muted-foreground">
                            Final name: <code>{fullSnapshotName}</code>
                          </p>
                        </div>

                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            onClick={() => pollStatus(false)}
                            disabled={polling}
                          >
                            <RefreshCw className="h-4 w-4 mr-1" />
                            Refresh
                          </Button>
                          <Button
                            onClick={publishSnapshot}
                            disabled={busy || !snapBase.trim()}
                          >
                            <Save className="h-4 w-4 mr-1" />
                            Publish Snapshot & Delete VM
                          </Button>
                          <Button
                            variant="destructive"
                            onClick={discardVm}
                            disabled={busy}
                          >
                            <Trash2 className="h-4 w-4 mr-1" />
                            Discard VM
                          </Button>
                        </div>
                      </div>

                      <div className="flex justify-center mr-5">
                        <div className="w-72 md:w-80">
                          <Lottie animationData={vmAnim} loop autoplay />
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ) : null}
            </div>
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
