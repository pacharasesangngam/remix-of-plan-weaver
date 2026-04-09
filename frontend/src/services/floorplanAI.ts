import type { DetectFloorPlanResult } from "@/types/detection";

async function fileToBlob(file: File | string): Promise<Blob> {
  if (typeof file === "string") {
    const resp = await fetch(file);
    return await resp.blob();
  }
  return file;
}

export async function detectFloorPlan(file: File) {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch("http://localhost:8000/api/detect-floorplan", {
    method: "POST",
    body: formData,
  });

  if (!res.ok) throw new Error("Backend error");

  return await res.json();
}