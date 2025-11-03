import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { GitBranch, Loader2, ChevronLeft } from "lucide-react";

interface ParameterConfigurationProps {
  backend: string;
  module: string;
  onComplete: () => void;
  onBack?: () => void;
}

export function ParameterConfiguration({
  backend,
  module,
  onComplete,
  onBack,
}: ParameterConfigurationProps) {
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();

  // Mock parameters - in production, these would be dynamically loaded based on the module
  const [parameters, setParameters] = useState({
    resourceName: "",
    location: "",
    environment: "",
    size: "",
    tags: "",
  });

  const handleSubmit = async () => {
    // Validate all required fields
    const requiredFields = Object.entries(parameters).filter(([key, value]) => !value);
    
    if (requiredFields.length > 0) {
      toast({
        title: "Required Fields Missing",
        description: "Please fill in all required parameters.",
        variant: "destructive",
      });
      return;
    }

    setSubmitting(true);

    // Simulate processing and GitLab MR creation
    setTimeout(() => {
      toast({
        title: "Merge Request Created",
        description: "Your configuration has been packaged and sent to GitLab.",
      });
      setSubmitting(false);
      onComplete();
    }, 2000);
  };

  return (
    <div className="space-y-6">
      <div className="bg-muted/50 p-4 rounded-lg space-y-1">
        <p className="text-sm font-medium">Configuration Summary</p>
        <p className="text-sm text-muted-foreground">Backend: {backend}</p>
        <p className="text-sm text-muted-foreground">Module: {module}</p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="resourceName">Resource Name *</Label>
          <Input
            id="resourceName"
            placeholder="my-resource"
            value={parameters.resourceName}
            onChange={(e) => setParameters({ ...parameters, resourceName: e.target.value })}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="location">Azure Region *</Label>
          <Select
            value={parameters.location}
            onValueChange={(value) => setParameters({ ...parameters, location: value })}
          >
            <SelectTrigger id="location">
              <SelectValue placeholder="Select region" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="eastus">East US</SelectItem>
              <SelectItem value="westus">West US</SelectItem>
              <SelectItem value="westeurope">West Europe</SelectItem>
              <SelectItem value="northeurope">North Europe</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="environment">Environment *</Label>
          <Select
            value={parameters.environment}
            onValueChange={(value) => setParameters({ ...parameters, environment: value })}
          >
            <SelectTrigger id="environment">
              <SelectValue placeholder="Select environment" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="dev">Development</SelectItem>
              <SelectItem value="staging">Staging</SelectItem>
              <SelectItem value="production">Production</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="size">Size *</Label>
          <Select
            value={parameters.size}
            onValueChange={(value) => setParameters({ ...parameters, size: value })}
          >
            <SelectTrigger id="size">
              <SelectValue placeholder="Select size" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="small">Small (Standard_B1s)</SelectItem>
              <SelectItem value="medium">Medium (Standard_B2s)</SelectItem>
              <SelectItem value="large">Large (Standard_D2s_v3)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="tags">Tags (JSON format) *</Label>
          <Textarea
            id="tags"
            placeholder='{"project": "myapp", "owner": "team"}'
            value={parameters.tags}
            onChange={(e) => setParameters({ ...parameters, tags: e.target.value })}
            rows={3}
          />
        </div>
      </div>

      <div className="bg-muted/50 p-4 rounded-lg">
        <p className="text-sm text-muted-foreground">
          These parameters will be injected into the tfvars file using Jinja2 templating
          and packaged into a merge request for your GitLab repository.
        </p>
      </div>

      <div className="flex gap-3">
        {onBack && (
          <Button 
            onClick={onBack} 
            variant="outline"
            className="flex-1"
            disabled={submitting}
          >
            <ChevronLeft className="mr-2 h-4 w-4" />
            Previous
          </Button>
        )}
        <Button onClick={handleSubmit} className="flex-1" disabled={submitting}>
          {submitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Creating Merge Request...
            </>
          ) : (
            <>
              <GitBranch className="mr-2 h-4 w-4" />
              Create GitLab Merge Request
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
