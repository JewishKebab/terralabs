import { useEffect, useMemo, useState } from "react";
import axios, { AxiosHeaders } from "axios";

export type MeResponse = {
  id: number;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  role?: "asgard" | "teacher" | "student" | "unknown";
  course_scope?: string[];     // e.g., ["tichnut-a","tichnut-b"] or ["devops"]
  course_family?: string | null; // e.g., "tichnut" | "devops" | "cyber"
  groups?: Array<{ id: string; name?: string }>;
};

const API_BASE = "http://localhost:5000";

export function useAccess() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const api = useMemo(() => {
    const i = axios.create({
      baseURL: API_BASE,
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
        if (mounted) setMe(res.data as MeResponse);
      } catch {
        if (mounted) setMe(null);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [api]);

  const role = me?.role ?? "unknown";
  const isAsgard = role === "asgard";
  const isTeacher = role === "teacher";
  const isStudent = role === "student";
  const courseScope = me?.course_scope ?? [];
  const courseFamily = me?.course_family ?? null;

  return {
    loading,
    me,
    role,
    isAsgard,
    isTeacher,
    isStudent,
    courseScope,
    courseFamily,
  };
}
