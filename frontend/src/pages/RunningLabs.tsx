import { useEffect, useMemo, useState } from "react";
import axios, { AxiosHeaders } from "axios";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/dashboard/AppSidebar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { RefreshCw, Server, HardDrive, Network, Clock } from "lucide-react";
import logo from "@/assets/terralabs-logo.png";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@/components/ui/select";

type Vm = {
  id: string;
  name: string;
  private_ip?: string | null;
  public_ip?: string | null;
  size?: string | null;
  power_state?: string | null;
  tags?: Record<string, string>;
};

type Lab = {
  lab_id: string;
  course: string;
  expires_at?: string | null;
  created_at?: string | null;
  vms: Vm[];
};

export default function RunningLabsPage() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [labs, setLabs] = useState<Lab[]>([]);

  // global filters
  const [globalLabQuery, setGlobalLabQuery] = useState("");
  const [courseFilter, setCourseFilter] = useState<string>("all");

  // per-lab VM private IP query
  const [vmSearch, setVmSearch] = useState<Record<string, string>>({}); // key: `${course}:${lab_id}`

  const api = useMemo(() => {
    const i = axios.create({
      baseURL: "http://localhost:5000",
      headers: new AxiosHeaders({ "Content-Type": "application/json" }),
      timeout: 20000,
    });
    i.interceptors.request.use((config) => {
      config.headers = AxiosHeaders.from(config.headers);
      const t = localStorage.getItem("auth_token");
      if (t) (config.headers as AxiosHeaders).set("Authorization", `Bearer ${t}`);
      return config;
    });
    return i;
  }, []);

  const fetchLabs = async () => {
    try {
      setLoading(true);
      const res = await api.get("/api/labs/running");
      setLabs(res.data?.labs ?? []);
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Failed to load labs",
        description: err?.response?.data?.error || err?.message || "Failed to fetch running labs",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLabs();
  }, []); // eslint-disable-line

  const courses = useMemo(() => {
    const set = new Set<string>();
    labs.forEach((l) => set.add(l.course || ""));
    return Array.from(set).sort();
  }, [labs]);

  // power controls
  const requestAction = async (
    kind: "start" | "stop",
    vmId: string,
    opts?: { deallocate?: boolean }
  ) => {
    try {
      const url =
        kind === "start" ? "/api/vm/start" : "/api/vm/stop";
      await api.post(url, { vm_id: vmId, deallocate: opts?.deallocate ?? true });
      toast({
        title: kind === "start" ? "Start requested" : "Stop requested",
        description: "Azure will process the request shortly.",
      });
      // brief refresh
      setTimeout(fetchLabs, 1500);
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Action failed",
        description: err?.response?.data?.error || err?.message || "Unexpected error.",
      });
    }
  };

  // filtered labs by global toolbar
  const filteredLabs = useMemo(() => {
    const q = globalLabQuery.trim().toLowerCase();
    return labs.filter((lab) => {
      const matchesCourse = courseFilter === "all" || lab.course === courseFilter;
      const matchesLab = !q || lab.lab_id.toLowerCase().includes(q);
      return matchesCourse && matchesLab;
    });
  }, [labs, globalLabQuery, courseFilter]);

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full bg-background">
        <AppSidebar />

        <div className="flex-1 flex flex-col">
          {/* Header (same as Dashboard look) */}
          <header className="h-16 border-b bg-card flex items-center justify-between px-6 shadow-sm">
            <div className="flex items-center gap-4">
              <SidebarTrigger />
              <div className="py-2 rounded-md">
                <img src={logo} alt="TerraLabs" className="h-10" />
              </div>
              <h1 className="text-xl font-semibold">Running Labs</h1>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={fetchLabs}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Refresh
              </Button>
            </div>
          </header>

          {/* Content */}
          <main className="flex-1 p-6 overflow-auto">
            <div className="max-w-6xl mx-auto space-y-6">

              {/* Global toolbar */}
              <Card className="shadow-elegant">
                <CardContent className="py-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="space-y-1">
                      <div className="text-xs text-muted-foreground">Search Lab</div>
                      <Input
                        placeholder="e.g. step1"
                        value={globalLabQuery}
                        onChange={(e) => setGlobalLabQuery(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs text-muted-foreground">Filter by Course</div>
                      <Select
                        value={courseFilter}
                        onValueChange={(v) => setCourseFilter(v)}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="All courses" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All courses</SelectItem>
                          {courses.map((c) => (
                            <SelectItem key={c || "none"} value={c || ""}>
                              {c || "(none)"}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-end">
                      <Button
                        variant="secondary"
                        className="w-full md:w-auto"
                        onClick={() => {
                          setGlobalLabQuery("");
                          setCourseFilter("all");
                        }}
                      >
                        Clear
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {loading ? (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Server className="h-5 w-5" />
                      Loading labs…
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <Skeleton className="h-6 w-1/3" />
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                  </CardContent>
                </Card>
              ) : filteredLabs.length === 0 ? (
                <Card className="shadow-elegant">
                  <CardHeader>
                    <CardTitle>No running labs found.</CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm text-muted-foreground">
                    Once your pipelines finish and VMs are up, they’ll appear here.
                  </CardContent>
                </Card>
              ) : (
                filteredLabs.map((lab) => {
                  const key = `${lab.course}:${lab.lab_id}`;
                  const privateIpQuery = (vmSearch[key] || "").trim();

                  const vms = privateIpQuery
                    ? lab.vms.filter((v) =>
                        (v.private_ip || "")
                          .toLowerCase()
                          .includes(privateIpQuery.toLowerCase())
                      )
                    : lab.vms;

                  return (
                    <Card key={key} className="shadow-elegant">
                      <CardHeader>
                        <div className="flex items-center justify-between gap-4">
                          <CardTitle className="flex items-center gap-2">
                            <Server className="h-5 w-5" />
                            <span className="font-semibold">{lab.lab_id}</span>
                            <Badge variant="secondary" className="uppercase">
                              {lab.course || "unknown"}
                            </Badge>
                          </CardTitle>

                          <div className="flex-1" />

                          <div className="hidden md:flex items-center gap-6 text-sm text-muted-foreground mr-5">
                            {lab.created_at && (
                              <span className="inline-flex items-center gap-1">
                                <Clock className="h-4 w-4" />{" "}
                                Created: {new Date(lab.created_at).toLocaleString()}
                              </span>
                            )}
                            {lab.expires_at && (
                              <span className="inline-flex items-center gap-1">
                                <Clock className="h-4 w-4" />{" "}
                                Expires: {new Date(lab.expires_at).toLocaleString()}
                              </span>
                            )}
                          </div>

                          {/* Per-lab VM Private IP search */}
                          <div className="w-full md:w-64 mb-4">
                            <div className="text-xs text-muted-foreground mb-1">
                              Search VM Private IP
                            </div>
                            <Input
                              placeholder="e.g. 10.98.0.4"
                              value={privateIpQuery}
                              onChange={(e) =>
                                setVmSearch((s) => ({ ...s, [key]: e.target.value }))
                              }
                            />
                          </div>
                        </div>
                      </CardHeader>

                      <CardContent>
                        {vms.length === 0 ? (
                          <p className="text-sm text-muted-foreground">
                            No VMs match this filter.
                          </p>
                        ) : (
                          <div className="overflow-x-auto rounded-md border">
                            <Table className="min-w-[820px]">
                              <TableHeader>
                                <TableRow>
                                  <TableHead className="w-1/3">Name</TableHead>
                                  <TableHead className="w-1/6">Size</TableHead>
                                  <TableHead className="w-1/6">Private IP</TableHead>
                                  <TableHead className="w-1/6">Power</TableHead>
                                  <TableHead className="w-1/6 text-center">Actions</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {vms.map((vm) => (
                                  <TableRow key={vm.id}>
                                    <TableCell className="font-medium">
                                      <div className="flex items-center gap-2">
                                        <HardDrive className="h-4 w-4" />
                                        {vm.name}
                                      </div>
                                    </TableCell>

                                    <TableCell>{vm.size || "-"}</TableCell>

                                    <TableCell>
                                      <div className="inline-flex items-center gap-2">
                                        <Network className="h-4 w-4" />
                                        {vm.private_ip || "-"}
                                      </div>
                                    </TableCell>

                                    <TableCell>
                                      <Badge
                                        variant={
                                          vm.power_state === "running"
                                            ? "default"
                                            : "secondary"
                                        }
                                        className={
                                          vm.power_state === "running"
                                            ? "bg-violet-600"
                                            : ""
                                        }
                                      >
                                        {(vm.power_state || "-").toUpperCase()}
                                      </Badge>
                                    </TableCell>

                                    {/* Centered actions */}
                                    <TableCell className="text-center">
                                      <div className="flex items-center justify-center gap-2">
                                        {vm.power_state === "running" ? (
                                          <Button
                                            variant="destructive"
                                            size="sm"
                                            onClick={() =>
                                              requestAction("stop", vm.id, {
                                                deallocate: true,
                                              })
                                            }
                                          >
                                            Stop
                                          </Button>
                                        ) : (
                                          <Button
                                            size="sm"
                                            onClick={() => requestAction("start", vm.id)}
                                          >
                                            Start
                                          </Button>
                                        )}
                                      </div>
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  );
                })
              )}
            </div>
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
