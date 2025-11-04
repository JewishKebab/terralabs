import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";
import logo from "@/assets/terralabs-logo.png";
import axios from "axios";

const api = axios.create({
  baseURL: "http://localhost:5000",
  headers: { "Content-Type": "application/json" },
  // withCredentials: true, // enable only if you use cookies on the backend
  timeout: 15000,
});

const AuthPage = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();

  const postJson = useCallback(async (path: string, body: unknown) => {
    const res = await api.post(path, body);
    return res.data;
  }, []);

  const extractErr = (err: unknown) => {
    const e = err as any;
    return (
      e?.response?.data?.error ||
      e?.response?.data?.message ||
      e?.message ||
      "Request failed"
    );
  };

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

          // prefer client-side route change
          navigate("/dashboard", { replace: true });

          // hard fallback if your Router base or navigate fails
          if (data.redirect_url) {
            window.location.assign(data.redirect_url); // "/dashboard"
        }
        toast({ title: "Signed in", description: "Welcome back!" });
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

  const handleSignup = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (loading) return;
      setLoading(true);
      try {
        const data = await postJson("/api/signup", { email, password });
        const token = data?.token;
        if (!token) throw new Error("No token returned from server.");
        localStorage.setItem("auth_token", token);
        toast({ title: "Account created", description: "You’re all set!" });
        navigate("/");
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
    [email, password, loading, navigate, postJson, toast]
  );

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-subtle p-4">
      <div className="w-full max-w-md">
        <div className="flex items-center justify-center mb-8">
          <div className="bg-[#1a1a1a] px-8 py-4 rounded-lg">
            <img src={logo} alt="TerraLabs" className="h-10" />
          </div>
        </div>

        <Card className="shadow-elegant">
          <CardHeader>
            <CardTitle>Welcome</CardTitle>
            <CardDescription>
              Sign in to manage your cloud resources
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="login">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="login">Login</TabsTrigger>
                <TabsTrigger value="signup">Sign Up</TabsTrigger>
              </TabsList>

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
                    <Input
                      id="login-password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
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
                </form>
              </TabsContent>

              <TabsContent value="signup">
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
                    <Input
                      id="signup-password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      minLength={6}
                    />
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
};

export default AuthPage;
