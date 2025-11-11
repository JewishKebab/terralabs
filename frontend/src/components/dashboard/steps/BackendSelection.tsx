import { useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@/components/ui/select";

/**
 * What the step sends back to the stepper when user finishes this step.
 */
export type LabInfo = {
  course: string;   // e.g. "tichnut-a", "devops", "cyber-b"
  labName: string;  // folder / lab id
};

type Props = {
  onComplete: (info: LabInfo) => void;
  /**
   * Optional allow-list of course ids the user may choose.
   * When provided, the dropdown shows only these and is disabled if there's only one.
   */
  lockToCourses?: string[];
};

/**
 * Central list of course ids you support in the UI.
 * Make sure these match what your backend expects.
 */
const ALL_COURSES = [
  "devops",
  "cyber-a",
  "cyber-b",
  "tichnut-a",
  "tichnut-b",
  "tichnut-c",
  "tichnut-d",
  "dc",
] as const;

const COURSE_LABEL: Record<string, string> = {
  "devops": "DevOps",
  "cyber-a": "Cyber A",
  "cyber-b": "Cyber B",
  "tichnut-a": "Tichnut A",
  "tichnut-b": "Tichnut B",
  "tichnut-c": "Tichnut C",
  "tichnut-d": "Tichnut D",
  "dc": "DC",
};

export function BackendSelection({ onComplete, lockToCourses }: Props) {
  const courseOptions = useMemo(() => {
    if (!lockToCourses || lockToCourses.length === 0) return ALL_COURSES as unknown as string[];
    // keep order defined in ALL_COURSES but filter by the allow-list
    const set = new Set(lockToCourses.map((c) => c.toLowerCase()));
    return (ALL_COURSES as unknown as string[]).filter((c) => set.has(c));
  }, [lockToCourses]);

  // default selection
  const [course, setCourse] = useState<string>(courseOptions[0] ?? "");
  const [labName, setLabName] = useState<string>("");

  // If the allow-list changes (role changes), reset default course
  useEffect(() => {
    if (courseOptions.length > 0 && !courseOptions.includes(course)) {
      setCourse(courseOptions[0]);
    }
  }, [courseOptions, course]);

  const onlyOneCourse = courseOptions.length === 1;

  return (
    <Card className="border-none shadow-none p-0">
      <CardContent className="p-0 space-y-6">
        {/* Course picker */}
        <div className="space-y-2">
          <Label>Course</Label>
          <Select
            value={course}
            onValueChange={setCourse}
            disabled={onlyOneCourse}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select course" />
            </SelectTrigger>
            <SelectContent>
              {courseOptions.map((c) => (
                <SelectItem key={c} value={c}>
                  {COURSE_LABEL[c] ?? c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {onlyOneCourse && (
            <p className="text-xs text-muted-foreground">
              Your access is scoped to <b>{COURSE_LABEL[course] ?? course}</b>.
            </p>
          )}
        </div>

        {/* Lab name */}
        <div className="space-y-2">
          <Label>Lab Name</Label>
          <Input
            placeholder="e.g. step1"
            value={labName}
            onChange={(e) => setLabName(e.target.value)}
          />
        </div>

        <div className="flex justify-end">
          <Button
            onClick={() => onComplete({ course, labName: labName.trim() })}
            disabled={!course || !labName.trim()}
          >
            Continue
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default BackendSelection;
