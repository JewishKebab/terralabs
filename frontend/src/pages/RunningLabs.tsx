import { useEffect, useMemo, useState } from "react";
import axios, { AxiosHeaders } from "axios";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/dashboard/AppSidebar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  RefreshCw,
  Server,
  HardDrive,
  Network,
  Clock,
  Trash2,
  Play,
  Square,
} from "lucide-react";
import logo from "@/assets/terralabs-logo.png";

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

  // Filters
  const [qLab, setQLab] = useState("");
  const [qIp, setQIp] = useState("");
  const [courseFilter, setCourseFilter] = useState<string>("__all__");

  // Delete dialog (single confirmation)
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteWorking, setDeleteWorking] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Lab | null>(null);

  const api = useMemo(() => {
    const i = axios.create({
      baseURL: "http://localhost:5000",
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

  const fetchLabs = async () => {
    try {
      setLoading(true);
      const res = await api.get("/api/labs/running");
      setLabs(res.data?.labs ?? []);
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Failed to load labs",
        description: err?.response?.data?.error || err?.message || "Unexpected error.",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLabs();
  }, []); // eslint-disable-line

  // Power controls
  const powerStart = async (vm: Vm) => {
    try {
      await api.post("/api/vm/start", { vm_id: vm.id });
      toast({ title: "Start requested", description: vm.name });
      fetchLabs();
    } catch (e: any) {
      toast({
        variant: "destructive",
        title: "Failed to start VM",
        description: e?.response?.data?.error || e?.message,
      });
    }
  };

  const powerStop = async (vm: Vm) => {
    try {
      await api.post("/api/vm/stop", { vm_id: vm.id, deallocate: true });
      toast({ title: "Stop (deallocate) requested", description: vm.name });
      fetchLabs();
    } catch (e: any) {
      toast({
        variant: "destructive",
        title: "Failed to stop VM",
        description: e?.response?.data?.error || e?.message,
      });
    }
  };

  // Delete flow
  const openDelete = (lab: Lab) => {
    setDeleteTarget(lab);
    setDeleteOpen(true);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteWorking(true);
    try {
      const body = {
        course: deleteTarget.course,
        lab_id: deleteTarget.lab_id,
      };
      const res = await api.post("/api/labs/delete", body);

      const mrUrl = res?.data?.delete_mr?.merge_request_url;
      toast({
        title: "Delete requested",
        description: mrUrl ? `MR opened: ${mrUrl}` : "Azure deletion + MR requested.",
      });

      setDeleteOpen(false);
      setDeleteTarget(null);
      fetchLabs();
    } catch (e: any) {
      toast({
        variant: "destructive",
        title: "Failed to request deletion",
        description: e?.response?.data?.error || e?.message,
      });
    } finally {
      setDeleteWorking(false);
    }
  };

  // Filters
  const courseOptions = Array.from(new Set(labs.map((l) => l.course))).sort();
  const filtered = labs.filter((lab) => {
    const byLab = qLab ? lab.lab_id.toLowerCase().includes(qLab.toLowerCase()) : true;
    const byCourse = courseFilter === "__all__" ? true : lab.course === courseFilter;
    const byIp = qIp
      ? lab.vms.some(
          (v) =>
            (v.private_ip || "").includes(qIp) ||
            (v.public_ip || "").includes(qIp)
        )
      : true;
    return byLab && byCourse && byIp;
  });

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full bg-background">
        <AppSidebar />

        <div className="flex-1 flex flex-col">
          {/* Header */}
          <header className="h-16 border-b bg-card flex items-center justify-between px-6 shadow-sm">
            <div className="flex items-center gap-4">
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

          {/* Filters */}
          <div className="px-6 pt-4 max-w-6xl mx-auto w-full">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <Label>Search Lab</Label>
                <Input
                  placeholder="e.g. step1"
                  value={qLab}
                  onChange={(e) => setQLab(e.target.value)}
                />
              </div>
              <div>
                <Label>Filter by Course</Label>
                <Select value={courseFilter} onValueChange={setCourseFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder="All courses" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">All courses</SelectItem>
                    {courseOptions.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Search VM Private IP</Label>
                <Input
                  placeholder="e.g. 10.98.0.4"
                  value={qIp}
                  onChange={(e) => setQIp(e.target.value)}
                />
              </div>
            </div>
          </div>

          {/* Content */}
          <main className="flex-1 p-6 overflow-auto">
            <div className="max-w-6xl mx-auto space-y-6">
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
              ) : filtered.length === 0 ? (
                <Card className="shadow-elegant">
                  <CardHeader>
                    <CardTitle>No running labs found</CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm text-muted-foreground">
                    Once your pipelines finish and VMs are up, they’ll appear here.
                  </CardContent>
                </Card>
              ) : (
                filtered.map((lab) => (
                  <Card
                    key={`${lab.course}:${lab.lab_id}`}
                    className="shadow-elegant"
                  >
                    <CardHeader>
                      <div className="flex items-center justify-between">
                        <CardTitle className="flex items-center gap-2">
                          <Server className="h-5 w-5" />
                          <span className="font-semibold">{lab.lab_id}</span>
                          <Badge variant="secondary">{lab.course}</Badge>
                        </CardTitle>

                        <div className="flex items-center gap-4 text-sm text-muted-foreground">
                          {lab.created_at && (
                            <span className="inline-flex items-center gap-1">
                              <Clock className="h-4 w-4" /> Created:{" "}
                              {new Date(lab.created_at).toLocaleString()}
                            </span>
                          )}
                          {lab.expires_at && (
                            <span className="inline-flex items-center gap-1">
                              <Clock className="h-4 w-4" /> Expires:{" "}
                              {new Date(lab.expires_at).toLocaleString()}
                            </span>
                          )}
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => openDelete(lab)}
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
                            Delete Lab
                          </Button>
                        </div>
                      </div>
                    </CardHeader>

                    <CardContent>
                      {lab.vms.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          No VMs discovered for this lab.
                        </p>
                      ) : (
                        <div className="overflow-x-auto rounded-md border">
                          <Table className="min-w-[720px]">
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-1/4">Name</TableHead>
                                <TableHead className="w-1/6">Size</TableHead>
                                <TableHead className="w-1/6">Private IP</TableHead>
                                <TableHead className="w-1/6">Power</TableHead>
                                <TableHead className="w-1/6 text-center">
                                  Actions
                                </TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {lab.vms.map((vm) => (
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
                                    <Badge variant="outline">
                                      {(vm.power_state || "").toUpperCase() || "-"}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className="text-center">
                                    <div className="inline-flex gap-2">
                                      <Button
                                        variant="secondary"
                                        size="sm"
                                        onClick={() => powerStart(vm)}
                                      >
                                        <Play className="h-4 w-4 mr-1" /> Start
                                      </Button>
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => powerStop(vm)}
                                      >
                                        <Square className="h-4 w-4 mr-1" /> Stop
                                      </Button>
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
                ))
              )}
            </div>
          </main>
        </div>
      </div>

      {/* Delete dialog (are you sure) */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Lab</DialogTitle>
            <DialogDescription>
              This will delete all Azure resources tagged for this lab, open a
              Merge Request that removes the lab folder from GitLab, and delete
              the lab&apos;s Terraform state. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 py-2 text-sm">
            <div>
              <span className="font-medium">Course:</span> {deleteTarget?.course}
            </div>
            <div>
              <span className="font-medium">Lab:</span> {deleteTarget?.lab_id}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={deleteWorking}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleteWorking}
            >
              {deleteWorking ? "Deleting…" : "Yes, delete everything"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  );
}
