"use client";
import { useRef, useState, useCallback, useEffect } from "react";
import { borrowWebcam, returnWebcam } from "@/lib/webcamShare";

export function useCamera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);

  const startCamera = useCallback(async (facingMode: "user" | "environment" = "user") => {
    try {
      setError(null);
      // On the demo laptop the AI camera engine holds the webcam: ask it to release it first.
      await borrowWebcam();
      const constraints = { video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (e: any) {
        // the engine may still be letting go of the device - retry once
        if (e?.name !== "NotReadableError" && !/in use|could not start/i.test(e?.message ?? "")) throw e;
        await new Promise((r) => setTimeout(r, 1500));
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => videoRef.current?.play();
      }
      setActive(true);
    } catch (err: unknown) {
      returnWebcam();
      setError((err as Error).message ?? "Camera access denied");
    }
  }, []);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setActive(false);
    returnWebcam(); // hand the webcam back to the AI camera engine
  }, []);

  // Turn the webcam off (and hand it back) when the component using it unmounts.
  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    returnWebcam();
  }, []);

  const captureFrame = useCallback((
    gpsData?: { lat: number; lng: number; address?: string }
  ): string | null => {
    if (!videoRef.current || !canvasRef.current) return null;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // GPS watermark overlay
    if (gpsData) {
      const now = new Date();
      const stamp = [
        `📍 ${gpsData.address ?? `${gpsData.lat.toFixed(5)}, ${gpsData.lng.toFixed(5)}`}`,
        `⏱ ${now.toLocaleString("en-IN")} | ${now.toLocaleDateString("en-IN", { weekday: "long" })}`,
        `🛰 GPS: ${gpsData.lat.toFixed(6)}, ${gpsData.lng.toFixed(6)}`,
        "EcoWatch™ Verified",
      ];
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(0, canvas.height - 90, canvas.width, 90);
      ctx.fillStyle = "#10b981";
      ctx.font = "bold 13px monospace";
      stamp.forEach((line, i) => ctx.fillText(line, 10, canvas.height - 75 + i * 20));
    }

    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    setCapturedImage(dataUrl);
    return dataUrl;
  }, []);

  const captureMultipleFrames = useCallback(
    async (count: number, delayMs = 500): Promise<string[]> => {
      const frames: string[] = [];
      for (let i = 0; i < count; i++) {
        const frame = captureFrame();
        if (frame) frames.push(frame);
        if (i < count - 1) await new Promise((r) => setTimeout(r, delayMs));
      }
      return frames;
    },
    [captureFrame]
  );

  const clearCapture = useCallback(() => setCapturedImage(null), []);

  return {
    videoRef,
    canvasRef,
    active,
    error,
    capturedImage,
    startCamera,
    stopCamera,
    captureFrame,
    captureMultipleFrames,
    clearCapture,
  };
}
