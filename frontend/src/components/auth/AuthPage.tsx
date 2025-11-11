import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import logo from "@/assets/terralabs-logo.png";
import axios, { AxiosHeaders } from "axios";

// MSAL
import { useMsal } from "@azure/msal-react";
import { InteractionStatus, AccountInfo } from "@azure/msal-browser";
import { loginRequest } from "@/components/auth/msal";

const API_BASE = "http://localhost:5000";

// Helper: clear stale MSAL flags (fixes interaction_in_progress after reloads)
function clearStaleMsalInteractionFlags() {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.toLowerCase().includes("interaction.status")) {
        sessionStorage.removeItem(key);
      }
    }
  } catch {
    /* no-op */
  }
}

const api = axios.create({
  baseURL: API_BASE,
  headers: new AxiosHeaders({ "Content-Type": "application/json" }),
  timeout: 15000,
});

export default function AuthPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [showSignupPassword, setShowSignupPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const navigate = useNavigate();
  const { toast } = useToast();

  // MSAL state from provider
  const { instance, accounts, inProgress } = useMsal();
  const msalExchangeOnce = useRef(false);

  // --- utils ---
  const extractErr = (err: unknown) => {
    const e = err as any;
    return (
      e?.response?.data?.error ||
      e?.response?.data?.message ||
      e?.message ||
      "Request failed"
    );
  };

  const postJson = useCallback(async (path: string, body: unknown) => {
    const res = await api.post(path, body);
    return res.data;
  }, []);

  // --- Local login ---
  const handleLogin = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (loading) return;
      setLoading(true);
      try {
        const data = await postJson("/api/login", { email, password });
        const token = data?.token;
        if (!token) throw new Error("No token returned from server.");
        localStorage.setItem("auth_token", token);
        toast({ title: "Signed in", description: "Welcome back!" });
        navigate("/dashboard", { replace: true });
      } catch (err) {
        toast({
          variant: "destructive",
          title: "Login failed",
          description: extractErr(err),
        });
      } finally {
        setLoading(false);
      }
    },
    [email, password, loading, navigate, postJson, toast]
  );

  // --- Local signup ---
  const handleSignup = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (loading) return;
      setLoading(true);
      try {
        const payload = {
          email,
          password,
          first_name: firstName,
          last_name: lastName,
        };
        const data = await postJson("/api/signup", payload);
        const token = data?.token;
        if (!token) throw new Error("No token returned from server.");
        localStorage.setItem("auth_token", token);
        toast({ title: "Account created", description: "You’re all set!" });
        navigate("/dashboard");
      } catch (err) {
        toast({
          variant: "destructive",
          title: "Signup failed",
          description: extractErr(err),
        });
      } finally {
        setLoading(false);
      }
    },
    [email, password, firstName, lastName, loading, navigate, postJson, toast]
  );

  // --- Microsoft SSO ---
  const signInWithMicrosoft = async () => {
    if (
      inProgress !== InteractionStatus.None &&
      inProgress !== InteractionStatus.Startup &&
      inProgress !== InteractionStatus.HandleRedirect
    ) {
      return;
    }
    clearStaleMsalInteractionFlags();

    try {
      await instance.loginRedirect(loginRequest);
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Microsoft sign-in failed",
        description: extractErr(err),
      });
    }
  };

  // After redirect, exchange ID token with backend exactly once
  useEffect(() => {
    const exchangeOnce = async (account: AccountInfo) => {
      if (msalExchangeOnce.current) return;
      msalExchangeOnce.current = true;
      try {
        const result = await instance.acquireTokenSilent({
          ...loginRequest,
          account,
        });
        const idToken = result.idToken;
        if (!idToken) throw new Error("Missing ID token from MSAL.");

        const res = await postJson("/api/aad/login", { id_token: idToken });
        const token: string | undefined = res?.token;
        if (!token) throw new Error("No app token from backend.");

        // Store app JWT
        localStorage.setItem("auth_token", token);

        // Normalize and store AAD tags
        const role = String(res?.role || "").toLowerCase();
        const course = res?.course || null;
        const section = res?.section || null;

        // Clear first to avoid stale values
        localStorage.removeItem("aad_role");
        localStorage.removeItem("aad_course");
        localStorage.removeItem("aad_section");
        localStorage.removeItem("aad_groups");

        localStorage.setItem("aad_role", role);
        if (role !== "asgard") {
          if (course) localStorage.setItem("aad_course", String(course));
          if (section) localStorage.setItem("aad_section", String(section));
        }

        // Store groups (backend may return `groups` or `group_names`)
        const groups = Array.isArray(res?.groups)
          ? res.groups
          : Array.isArray(res?.group_names)
          ? res.group_names
          : null;
        if (groups) localStorage.setItem("aad_groups", JSON.stringify(groups));

        toast({ title: "Signed in with Microsoft" });
        navigate("/dashboard", { replace: true });
      } catch (err) {
        console.error(err);
        toast({
          variant: "destructive",
          title: "AAD exchange failed",
          description: extractErr(err),
        });
      }
    };

    if (inProgress === InteractionStatus.None && accounts.length > 0) {
      exchangeOnce(accounts[0]);
    }
  }, [accounts, inProgress, instance, navigate, postJson, toast]);

  // --- UI ---
  return (
    <div className="min-h-screen flex items-start justify-center bg-gradient-subtle p-20">
      <div className="w-full max-w-md">
        <div className="flex items-center justify-center mb-6">
          <div className="px-8 py-2 rounded-lg">
            <img src={logo} alt="TerraLabs" className="h-25" />
          </div>
        </div>

        <Card className="shadow-elegant">
          <CardHeader>
            <CardTitle className="flex items-center justify-center">
              Welcome!
            </CardTitle>
            <CardDescription className="flex items-center justify-center">
              Sign in to manage your cloud resources
            </CardDescription>
          </CardHeader>

          <CardContent>
            <Tabs defaultValue="login">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="login">Login</TabsTrigger>
                <TabsTrigger value="signup">Sign Up</TabsTrigger>
              </TabsList>

              {/* LOGIN TAB */}
              <TabsContent value="login">
                <form onSubmit={handleLogin} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="login-email">Email</Label>
                    <Input
                      id="login-email"
                      type="email"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="login-password">Password</Label>
                    <div className="relative">
                      <Input
                        id="login-password"
                        type={showLoginPassword ? "text" : "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        className="pr-10"
                      />
                      <button
                        type="button"
                        onClick={() => setShowLoginPassword((prev) => !prev)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
                        tabIndex={-1}
                      >
                        {showLoginPassword ? (
                          <EyeOff className="h-5 w-5" />
                        ) : (
                          <Eye className="h-5 w-5" />
                        )}
                      </button>
                    </div>
                  </div>

                  <Button type="submit" className="w-full" disabled={loading}>
                    {loading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Signing in...
                      </>
                    ) : (
                      "Sign In"
                    )}
                  </Button>

                  {/* Microsoft SSO */}
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={signInWithMicrosoft}
                    disabled={inProgress !== InteractionStatus.None}
                  >
                    {inProgress !== InteractionStatus.None ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Opening Microsoft Sign-in…
                      </>
                    ) : (
                      "Sign in with Microsoft"
                    )}
                  </Button>
                </form>
              </TabsContent>

              {/* SIGNUP TAB */}
              <TabsContent value="signup">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="signup-first">First name</Label>
                    <Input
                      id="signup-first"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="signup-last">Last name</Label>
                    <Input
                      id="signup-last"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      required
                    />
                  </div>
                </div>

                <form onSubmit={handleSignup} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="signup-email">Email</Label>
                    <Input
                      id="signup-email"
                      type="email"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="signup-password">Password</Label>
                    <div className="relative">
                      <Input
                        id="signup-password"
                        type={showSignupPassword ? "text" : "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        minLength={6}
                        className="pr-10"
                      />
                      <button
                        type="button"
                        onClick={() => setShowSignupPassword((prev) => !prev)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
                        tabIndex={-1}
                      >
                        {showSignupPassword ? (
                          <EyeOff className="h-5 w-5" />
                        ) : (
                          <Eye className="h-5 w-5" />
                        )}
                      </button>
                    </div>
                  </div>

                  <Button type="submit" className="w-full" disabled={loading}>
                    {loading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Creating account...
                      </>
                    ) : (
                      "Create Account"
                    )}
                  </Button>
                </form>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
