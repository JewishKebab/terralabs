import { useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BackendSelection } from "./steps/BackendSelection";
import { ModuleSelection } from "./steps/ModuleSelection";
import { ParameterConfiguration } from "./steps/ParameterConfiguration";

const steps = [
  { id: 1, name: "Backend", description: "Choose or create backend" },
  { id: 2, name: "Module", description: "Select module" },
  { id: 3, name: "Parameters", description: "Configure parameters" },
];

export function ProvisioningStepper() {
  const [currentStep, setCurrentStep] = useState(1);
  const [backendData, setBackendData] = useState<string | null>(null);
  const [moduleData, setModuleData] = useState<string | null>(null);

  const handleBackendComplete = (backend: string) => {
    setBackendData(backend);
    setCurrentStep(2);
  };

  const handleModuleComplete = (module: string) => {
    setModuleData(module);
    setCurrentStep(3);
  };

  const handleParametersComplete = () => {
    // This will be implemented later for GitLab MR creation
    console.log("Parameters submitted");
  };

  const handleStepClick = (stepId: number) => {
    // Allow navigation to completed steps
    if (stepId < currentStep) {
      setCurrentStep(stepId);
    }
  };

  return (
    <div className="space-y-8">
      {/* Stepper Header */}
      <div className="flex items-center justify-between">
        {steps.map((step, index) => (
          <div key={step.id} className="flex items-center flex-1">
            <div className="flex flex-col items-center">
              <button
                onClick={() => handleStepClick(step.id)}
                disabled={step.id > currentStep}
                className={cn(
                  "h-10 w-10 rounded-full flex items-center justify-center font-semibold transition-all",
                  currentStep > step.id
                    ? "bg-primary text-primary-foreground shadow-glow cursor-pointer hover:opacity-80"
                    : currentStep === step.id
                    ? "bg-gradient-primary text-primary-foreground shadow-glow"
                    : "bg-muted text-muted-foreground cursor-not-allowed"
                )}
              >
                {currentStep > step.id ? (
                  <Check className="h-5 w-5" />
                ) : (
                  step.id
                )}
              </button>
              <div className="mt-2 text-center">
                <p className="text-sm font-medium">{step.name}</p>
                <p className="text-xs text-muted-foreground">{step.description}</p>
              </div>
            </div>
            {index < steps.length - 1 && (
              <div
                className={cn(
                  "flex-1 h-0.5 mx-4 transition-all",
                  currentStep > step.id ? "bg-primary" : "bg-border"
                )}
              >
                <ChevronRight className="h-4 w-4 text-muted-foreground mx-auto -mt-2" />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Step Content */}
      <Card className="shadow-elegant">
        <CardHeader>
          <CardTitle>{steps[currentStep - 1].name}</CardTitle>
          <CardDescription>{steps[currentStep - 1].description}</CardDescription>
        </CardHeader>
        <CardContent>
          {currentStep === 1 && (
            <BackendSelection onComplete={handleBackendComplete} />
          )}
          {currentStep === 2 && (
            <ModuleSelection 
              onComplete={handleModuleComplete}
              onBack={() => setCurrentStep(1)}
            />
          )}
          {currentStep === 3 && (
            <ParameterConfiguration
              backend={backendData!}
              module={moduleData!}
              onComplete={handleParametersComplete}
              onBack={() => setCurrentStep(2)}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
