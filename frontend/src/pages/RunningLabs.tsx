// src/pages/RunningLabs.tsx
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import axios, { AxiosHeaders } from "axios";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
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
  LogOut,
  Tag,
  User,
} from "lucide-react";
import logo from "@/assets/terralabs-logo.png";
import { useAccess } from "@/hooks/useAccess";

type Vm = {
  id: string;
  name: string;
  private_ip?: string | null;
  public_ip?: string | null;
  size?: string | null;
  power_state?: string | null;
  tags?: Record<string, string>;
};

type RunningLab = {
  lab_id: string;
  course: string;
  expires_at?: string | null;
  created_at?: string | null;
  vms: Vm[];
};

type PublishedLab = {
  lab_id: string;
  course: string;
  published: boolean;
  assigned_vm?: Vm | null;
};

const API_BASE = "http://localhost:5000";

/* -------------------- helpers -------------------- */
const getTagValueCI = (tags: Record<string, string> | undefined, key: string): string => {
  if (!tags) return "";
  const want = key.toLowerCase();
  for (const k of Object.keys(tags)) {
    if (k.toLowerCase() === want) return String(tags[k] ?? "");
  }
  return "";
};

const isTruthy = (v: string) => {
  const s = (v || "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y";
};

const toTitle = (input?: string | null) => {
  if (!input) return "";
  return input
    .split(/[ _]+/)
    .map((w) =>
      w
        .split(/[.-]/)
        .map((p) => (p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p))
        .join(w.includes(".") ? "." : w.includes("-") ? "-" : "")
    )
    .join(" ");
};

const csvEscape = (v: unknown) => {
  const s = v == null ? "" : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

const formatAssignee = (raw?: string | null) => {
  if (!raw) return "Not assigned";
  const base = raw.includes("@") ? raw.split("@")[0] : raw;
  return toTitle(
    base
      .split(/[.\-_ ]+/)
      .filter(Boolean)
      .join(" ")
  );
};

const isLabPublished = (lab: RunningLab): boolean => {
  return lab.vms.some((v) => isTruthy(getTagValueCI(v.tags, "published")));
};

// normalize course for matching
const normCourse = (c: string) =>
  (c || "").toLowerCase().trim().replace(/[_\s]+/g, "-");

// returns letter a|b|c|d if course is a tichnut variant, else null
const tichnutLetter = (course: string): string | null => {
  const m = normCourse(course).match(/^tichnut-?([abcd])$/);
  return m ? m[1] : null;
};

// is this course any tichnut (a/b/c/d)?
const isAnyTichnut = (course: string) => !!tichnutLetter(course);

// commander detection: segel whose stored course is plain "tichnut"
const isTichnutCommanderCourse = (stored: string) => /^tichnut(\s|$)/i.test(stored || "");

/* -------------------- component -------------------- */
export default function RunningLabsPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const { isStudent } = useAccess();

  const [loading, setLoading] = useState(true);

  // role/course from storage
  const role = (localStorage.getItem("aad_role") || "").toLowerCase();
  const myCourseStored = localStorage.getItem("aad_course") || "";
  const myCourseLower = myCourseStored.toLowerCase();

  const isSegel = role === "segel";
  const isAsgard = role === "asgard";
  const isTichnutCommander = isSegel && isTichnutCommanderCourse(myCourseStored);

  // optional segel sub-filter (A/B/C/D/All) for commander
  const [tichnutLetterFilter, setTichnutLetterFilter] = useState<
    "all" | "a" | "b" | "c" | "d"
  >("all");

  // staff data
  const [labs, setLabs] = useState<RunningLab[]>([]);

  // student data
  const [publishedLabs, setPublishedLabs] = useState<PublishedLab[]>([]);
  const [enrolling, setEnrolling] = useState<string | null>(null);

  // staff filters
  const [qLab, setQLab] = useState("");
  const [qIp, setQIp] = useState("");
  const [courseFilter, setCourseFilter] = useState<string>("__all__");

  // delete dialog
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteWorking, setDeleteWorking] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RunningLab | null>(null);

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

  /* ---------- student fetch ---------- */
  const fetchPublished = async () => {
    try {
      setLoading(true);
      const res = await api.get("/api/labs/published");

      const myCourse = (localStorage.getItem("aad_course") || "").toLowerCase();
      let items: PublishedLab[] = (res.data?.labs || []).filter(
        (l: PublishedLab) => l.published && (!myCourse || (l.course || "").toLowerCase() === myCourse)
      );

      // hydrate "my VM" if backend has it
      try {
        const me = await api.get("/api/labs/my-enrollment");
        const myVm: Vm | null = me.data?.vm || null;
        if (myVm) {
          items.forEach((l) => {
            if (!l.assigned_vm && l.lab_id === (myVm as any).lab_id && l.course === (myVm as any).course) {
              l.assigned_vm = myVm;
            }
          });
        }
      } catch {}

      setPublishedLabs(items);
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

  // student auto-refresh (after publish/unpublish + periodic + focus)
  useEffect(() => {
    if (!isStudent) return;
    const interval = setInterval(fetchPublished, 15000);
    const onVisible = () => !document.hidden && fetchPublished();
    window.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible as any);
    const onStorage = (ev: StorageEvent) => {
      if (ev.key === "labs_last_publish_toggle") fetchPublished();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      clearInterval(interval);
      window.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible as any);
      window.removeEventListener("storage", onStorage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStudent]);

  /* ---------- staff fetch ---------- */
  const fetchRunning = async () => {
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
    if (isStudent) fetchPublished();
    else fetchRunning();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStudent]);

  /* ---------- student actions ---------- */
  const enroll = async (lab: PublishedLab) => {
    const key = `${lab.course}:${lab.lab_id}`;
    setEnrolling(key);
    try {
      const res = await api.post(`/api/labs/${lab.course}/${lab.lab_id}/enroll`);
      const assigned: Vm | null = res.data?.vm || null;
      setPublishedLabs((prev) =>
        prev.map((l) =>
          l.course === lab.course && l.lab_id === lab.lab_id ? { ...l, assigned_vm: assigned } : l
        )
      );
      toast({
        title: "Enrolled",
        description: assigned ? `Assigned VM: ${assigned.name}` : "No VM available right now.",
      });
    } catch (e: any) {
      toast({
        variant: "destructive",
        title: "Failed to enroll",
        description: e?.response?.data?.error || e?.message,
      });
    } finally {
      setEnrolling(null);
    }
  };

  /* ---------- power ---------- */
  const powerStart = async (vm: Vm, after?: () => void) => {
    try {
      await api.post("/api/vm/start", { vm_id: vm.id });
      toast({ title: "Start requested", description: vm.name });
      after ? after() : (isStudent ? fetchPublished() : fetchRunning());
    } catch (e: any) {
      toast({
        variant: "destructive",
        title: "Failed to start VM",
        description: e?.response?.data?.error || e?.message,
      });
    }
  };

  const powerStop = async (vm: Vm, after?: () => void) => {
    try {
      await api.post("/api/vm/stop", { vm_id: vm.id, deallocate: true });
      toast({ title: "Stop (deallocate) requested", description: vm.name });
      after ? after() : (isStudent ? fetchPublished() : fetchRunning());
    } catch (e: any) {
      toast({
        variant: "destructive",
        title: "Failed to stop VM",
        description: e?.response?.data?.error || e?.message,
      });
    }
  };

  /* ---------- staff actions ---------- */
  const openDelete = (lab: RunningLab) => {
    setDeleteTarget(lab);
    setDeleteOpen(true);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteWorking(true);
    try {
      const body = { course: deleteTarget.course, lab_id: deleteTarget.lab_id };
      await api.post("/api/labs/delete", body);
      toast({ title: "Delete requested", description: "Azure deletion + MR requested." });
      setDeleteOpen(false);
      setDeleteTarget(null);
      fetchRunning();
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

  // publish/unpublish
  const publishLab = async (lab: RunningLab, publish: boolean) => {
    try {
      const path = publish
        ? `/api/labs/${lab.course}/${lab.lab_id}/publish`
        : `/api/labs/${lab.course}/${lab.lab_id}/unpublish`;
      await api.post(path);
      toast({
        title: publish ? "Lab published" : "Lab unpublished",
        description: `${lab.lab_id} (${lab.course})`,
      });
      fetchRunning();
      localStorage.setItem("labs_last_publish_toggle", String(Date.now()));
    } catch (e: any) {
      toast({
        variant: "destructive",
        title: "Publish action failed",
        description: e?.response?.data?.error || e?.message,
      });
    }
  };

  /* ---------- CSV per-lab (Student Name, IP) ---------- */
  const buildCsvForLab = (lab: RunningLab, ipFilter: string) => {
    const rows: string[] = [];
    rows.push(["Student Name", "IP"].map(csvEscape).join(","));

    const vms =
      ipFilter.trim() === ""
        ? lab.vms
        : lab.vms.filter(
            (v) =>
              (v.private_ip || "").includes(ipFilter) ||
              (v.public_ip || "").includes(ipFilter)
          );

    vms.forEach((v) => {
      const nameRaw = getTagValueCI(v.tags, "occupiedbystudent");
      const studentName = formatAssignee(nameRaw);
      const ips =
        v.private_ip && v.public_ip
          ? `${v.private_ip} / ${v.public_ip}`
          : v.private_ip || v.public_ip || "";
      rows.push([studentName, ips].map(csvEscape).join(","));
    });

    return rows.join("\n");
  };

  const handleExportCsvLab = (lab: RunningLab) => {
    const csv = buildCsvForLab(lab, qIp);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const a = document.createElement("a");
    a.href = url;
    a.download = `lab-${lab.course}-${lab.lab_id}-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  /* ---------- staff filters + segel scoping ---------- */
  // Start from fetched labs
  let baseLabs = labs;

  if (isSegel) {
    if (isTichnutCommander) {
      // commander sees any tichnut a/b/c/d
      baseLabs = labs.filter((l) => isAnyTichnut(l.course));
      // apply optional letter sub-filter
      if (tichnutLetterFilter !== "all") {
        baseLabs = baseLabs.filter((l) => tichnutLetter(l.course) === tichnutLetterFilter);
      }
    } else {
      // normal segel: only their exact course (match with normalization)
      const myNorm = normCourse(myCourseLower);
      baseLabs = labs.filter((l) => normCourse(l.course) === myNorm);
    }
  }

  const courseOptions = Array.from(new Set(baseLabs.map((l) => l.course))).sort();

  const filteredLabs = baseLabs.filter((lab) => {
    const byCourse =
      isSegel
        ? true
        : courseFilter === "__all__"
        ? true
        : lab.course === courseFilter;

    const byLab = qLab ? lab.lab_id.toLowerCase().includes(qLab.toLowerCase()) : true;

    const byIp = qIp
      ? lab.vms.some(
          (v) => (v.private_ip || "").includes(qIp) || (v.public_ip || "").includes(qIp)
        )
      : true;

    return byCourse && byLab && byIp;
  });

  /* ---------- misc ---------- */
  const handleLogout = () => {
    localStorage.removeItem("auth_token");
    navigate("/auth", { replace: true });
  };

  const onRefresh = () => {
    if (isStudent) fetchPublished();
    else fetchRunning();
  };

  const isRunning = (vm?: Vm | null) =>
    (vm?.power_state || "").toLowerCase().includes("running");
  const isStarting = (vm?: Vm | null) =>
    (vm?.power_state || "").toLowerCase().includes("starting");
  const isStopped = (vm?: Vm | null) => {
    const s = (vm?.power_state || "").toLowerCase();
    return s.includes("deallocated") || s.includes("stopped");
  };

  /* -------------------- UI -------------------- */
  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full bg-background">
        <AppSidebar />

        <div className="flex-1 flex flex-col">
          {/* Header */}
          <header className="h-16 border-b bg-card flex items-center justify-between px-6 shadow-sm">
            <div className="flex items-center gap-4">
              <SidebarTrigger />
              <div className="py-2 rounded-md">
                <img src={logo} alt="TerraLabs" className="h-12" />
              </div>
              <h1 className="text-xl font-semibold">{isStudent ? "Labs" : "Running Labs"}</h1>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={onRefresh}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Refresh
              </Button>
              <Button variant="outline" size="sm" onClick={handleLogout}>
                <LogOut className="mr-2 h-4 w-4" />
                Logout
              </Button>
            </div>
          </header>

          {/* Content */}
          <main className="flex-1 p-6 overflow-auto">
            <div className="mx-auto w-full max-w-[1200px] space-y-6">
              {isStudent ? (
                /* --- Student view --- */
                loading ? (
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <Tag className="h-5 w-5" />
                        Loading published labs…
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <Skeleton className="h-6 w-1/3" />
                      <Skeleton className="h-16 w-full" />
                      <Skeleton className="h-16 w-full" />
                    </CardContent>
                  </Card>
                ) : publishedLabs.length === 0 ? (
                  <Card className="shadow-elegant">
                    <CardHeader>
                      <CardTitle>No published labs</CardTitle>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground">
                      When a lab is published by your instructor, it will appear here.
                    </CardContent>
                  </Card>
                ) : (
                  <Card className="shadow-elegant">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <Tag className="h-5 w-5" />
                        Published Labs
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {publishedLabs.map((lab) => {
                        const key = `${lab.course}:${lab.lab_id}`;
                        const vm = lab.assigned_vm || null;
                        return (
                          <div key={key} className="w-full rounded-lg border p-5 md:p-6 flex flex-col gap-3">
                            <div className="flex items-center justify-between">
                              <div className="space-y-1">
                                <div className="font-semibold text-lg">{lab.lab_id}</div>
                              </div>
                              <div className="flex items-center gap-3">
                                {!vm && (
                                  <Button size="sm" onClick={() => enroll(lab)} disabled={enrolling === key}>
                                    {enrolling === key ? "Enrolling…" : "Enroll"}
                                  </Button>
                                )}
                              </div>
                            </div>

                            {vm ? (
                              <div className="mt-1 w-full rounded-md border p-4 bg-muted/30">
                                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                                  <div className="grid gap-2 md:grid-cols-3 md:gap-6 text-sm">
                                    <div className="flex items-center gap-2">
                                      <HardDrive className="h-4 w-4" />
                                      <span className="font-medium">{vm.name}</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <Network className="h-4 w-4" />
                                      {vm.private_ip || "-"}
                                    </div>
                                    <div>
                                      <Badge variant="outline">{(vm.power_state || "-").toUpperCase()}</Badge>
                                    </div>
                                  </div>

                                  <div className="flex items-center gap-2">
                                    <Button
                                      variant="secondary"
                                      size="sm"
                                      disabled={isRunning(vm) || isStarting(vm)}
                                      onClick={() => powerStart(vm, fetchPublished)}
                                    >
                                      <Play className="h-4 w-4 mr-1" />
                                      Start
                                    </Button>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      disabled={isStopped(vm)}
                                      onClick={() => powerStop(vm, fetchPublished)}
                                    >
                                      <Square className="h-4 w-4 mr-1" />
                                      Stop
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </CardContent>
                  </Card>
                )
              ) : (
                /* --- Staff / Segel view --- */
                <>
                  {/* Filters */}
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
                      {/* Asgard gets all-course dropdown; Tichnut commander gets A/B/C/D filter; regular segel gets readonly */}
                      <Label>Course</Label>
                      {isAsgard ? (
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
                      ) : isTichnutCommander ? (
                        <Select
                          value={tichnutLetterFilter}
                          onValueChange={(v: "all" | "a" | "b" | "c" | "d") => setTichnutLetterFilter(v)}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Tichnut A, B, C, D" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">Tichnut A, B, C, D</SelectItem>
                            <SelectItem value="a">Tichnut A</SelectItem>
                            <SelectItem value="b">Tichnut B</SelectItem>
                            <SelectItem value="c">Tichnut C</SelectItem>
                            <SelectItem value="d">Tichnut D</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        <div className="h-10 inline-flex items-center gap-2 px-3 rounded-md border bg-muted/30 text-sm">
                          {myCourseStored || "—"}
                        </div>
                      )}
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
                        <CardTitle>No running labs found</CardTitle>
                      </CardHeader>
                      <CardContent className="text-sm text-muted-foreground">
                        Once your pipelines finish and VMs are up, they’ll appear here.
                      </CardContent>
                    </Card>
                  ) : (
                    filteredLabs.map((lab) => {
                      const vmsToShow =
                        qIp.trim() === ""
                          ? lab.vms
                          : lab.vms.filter(
                              (v) =>
                                (v.private_ip || "").includes(qIp) ||
                                (v.public_ip || "").includes(qIp)
                            );

                      const published = isLabPublished(lab);

                      return (
                        <Card key={`${lab.course}:${lab.lab_id}`} className="shadow-elegant">
                          <CardHeader>
                            <div className="flex items-center justify-between">
                              <CardTitle className="flex items-center gap-2">
                                <Server className="h-5 w-5" />
                                <span className="font-semibold">{lab.lab_id}</span>
                                <Badge variant="secondary">{lab.course}</Badge>
                                {published ? (
                                  <Badge className="ml-2" variant="default">
                                    Published
                                  </Badge>
                                ) : (
                                  <Badge className="ml-2" variant="outline">
                                    Not published
                                  </Badge>
                                )}
                              </CardTitle>

                              <div className="flex items-center gap-2">
                                {/* Per-lab CSV export */}
                                <Button
                                  size="sm"
                                  className="bg-emerald-700 text-white hover:bg-emerald-800"
                                  onClick={() => handleExportCsvLab(lab)}
                                >
                                  Export to CSV
                                </Button>

                                {!published ? (
                                  <Button
                                    size="sm"
                                    className="bg-black text-white hover:bg-black/90"
                                    onClick={() => publishLab(lab, true)}
                                  >
                                    Publish
                                  </Button>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => publishLab(lab, false)}
                                  >
                                    Unpublish
                                  </Button>
                                )}

                                <div className="hidden md:flex items-center gap-4 text-sm text-muted-foreground mx-2">
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
                                </div>

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
                            {vmsToShow.length === 0 ? (
                              <p className="text-sm text-muted-foreground">
                                No VMs matched your IP filter in this lab.
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
                                      <TableHead className="w-1/6">Assigned to</TableHead>
                                      <TableHead className="w-1/6 text-center">Actions</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {vmsToShow.map((vm) => (
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
                                        <TableCell>
                                          <div className="inline-flex items-center gap-2">
                                            <User className="h-4 w-4 text-gray-500" />
                                            {formatAssignee(
                                              getTagValueCI(vm.tags, "occupiedbystudent")
                                            )}
                                          </div>
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
                      );
                    })
                  )}
                </>
              )}
            </div>
          </main>
        </div>
      </div>

      {/* Staff delete dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Lab</DialogTitle>
            <DialogDescription>
              This will delete all Azure resources tagged for this lab, open a Merge Request that
              removes the lab folder from GitLab, and delete the lab&apos;s Terraform state.
              This action cannot be undone.
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
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleteWorking}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleteWorking}>
              {deleteWorking ? "Deleting…" : "Yes, delete everything"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  );
}
