import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Cloud, Workflow, Zap, Shield } from "lucide-react";

const Index = () => {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-gradient-subtle">
      {/* Hero Section */}
      <div className="container mx-auto px-4 py-20">
        <div className="max-w-4xl mx-auto text-center">
          <div className="flex items-center justify-center mb-8 gap-3">
            <div className="h-16 w-16 rounded-2xl bg-gradient-primary flex items-center justify-center shadow-glow">
              <Cloud className="h-9 w-9 text-primary-foreground" />
            </div>
          </div>
          
          <h1 className="text-5xl md:text-6xl font-bold mb-6 bg-gradient-primary bg-clip-text text-transparent">
            TerraLabs 
          </h1>
          
          <p className="text-xl text-muted-foreground mb-8 max-w-2xl mx-auto">
            Empower your team to create and manage cloud resources with ease.
            Streamlined Terraform workflows for Azure infrastructure.
          </p>

          <Button size="lg" onClick={() => navigate("/auth")} className="shadow-elegant">
            Get Started
          </Button>
        </div>

        {/* Features */}
        <div className="grid md:grid-cols-3 gap-8 mt-20 max-w-5xl mx-auto">
          <div className="bg-card p-6 rounded-xl shadow-elegant text-center">
            <div className="h-12 w-12 rounded-lg bg-gradient-primary flex items-center justify-center shadow-glow mx-auto mb-4">
              <Workflow className="h-6 w-6 text-primary-foreground" />
            </div>
            <h3 className="font-semibold mb-2">Simplified Workflows</h3>
            <p className="text-sm text-muted-foreground">
              Intuitive step-by-step process for provisioning infrastructure
            </p>
          </div>

          <div className="bg-card p-6 rounded-xl shadow-elegant text-center">
            <div className="h-12 w-12 rounded-lg bg-gradient-primary flex items-center justify-center shadow-glow mx-auto mb-4">
              <Zap className="h-6 w-6 text-primary-foreground" />
            </div>
            <h3 className="font-semibold mb-2">Fast Deployment</h3>
            <p className="text-sm text-muted-foreground">
              Automated GitLab integration for quick infrastructure deployment
            </p>
          </div>

          <div className="bg-card p-6 rounded-xl shadow-elegant text-center">
            <div className="h-12 w-12 rounded-lg bg-gradient-primary flex items-center justify-center shadow-glow mx-auto mb-4">
              <Shield className="h-6 w-6 text-primary-foreground" />
            </div>
            <h3 className="font-semibold mb-2">Secure & Compliant</h3>
            <p className="text-sm text-muted-foreground">
              Built-in security controls and compliance standards
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Index;
