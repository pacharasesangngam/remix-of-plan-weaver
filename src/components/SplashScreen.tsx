import { useEffect, useState } from "react";

interface SplashScreenProps {
  onComplete: () => void;
}

const SplashScreen = ({ onComplete }: SplashScreenProps) => {
  const [phase, setPhase] = useState<"enter" | "idle" | "exit">("enter");
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    // Progress bar animation
    const progressInterval = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 100) {
          clearInterval(progressInterval);
          return 100;
        }
        return prev + 2;
      });
    }, 30);

    // Start fade-out after 2s
    const exitTimer = setTimeout(() => {
      setPhase("exit");
    }, 2000);

    // Call onComplete after fade-out animation
    const completeTimer = setTimeout(() => {
      onComplete();
    }, 2700);

    return () => {
      clearInterval(progressInterval);
      clearTimeout(exitTimer);
      clearTimeout(completeTimer);
    };
  }, [onComplete]);

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center bg-background transition-opacity duration-700 ${
        phase === "exit" ? "opacity-0 pointer-events-none" : "opacity-100"
      }`}
    >
      {/* Background grid pattern */}
      <div
        className="absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage: `
            linear-gradient(hsl(var(--border)) 1px, transparent 1px),
            linear-gradient(90deg, hsl(var(--border)) 1px, transparent 1px)
          `,
          backgroundSize: "40px 40px",
        }}
      />

      {/* Glow */}
      <div
        className="absolute w-[400px] h-[400px] rounded-full opacity-10 blur-[120px]"
        style={{ background: "hsl(var(--primary))" }}
      />

      {/* Content */}
      <div
        className={`relative flex flex-col items-center gap-8 transition-all duration-700 ${
          phase === "enter" ? "translate-y-2 opacity-0" : "translate-y-0 opacity-100"
        }`}
        style={{ transitionDelay: phase === "enter" ? "100ms" : "0ms" }}
      >
        {/* Icon */}
        <div className="relative">
          <div
            className="w-20 h-20 rounded-2xl flex items-center justify-center border border-border"
            style={{ background: "hsl(var(--surface-raised))" }}
          >
            {/* 3D-like floor plan icon */}
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
              {/* Floor plan top */}
              <rect x="6" y="6" width="13" height="11" rx="1" stroke="hsl(var(--primary))" strokeWidth="1.5" fill="hsl(var(--primary) / 0.1)" />
              <rect x="21" y="6" width="13" height="11" rx="1" stroke="hsl(var(--primary))" strokeWidth="1.5" fill="hsl(var(--primary) / 0.08)" />
              <rect x="6" y="19" width="28" height="15" rx="1" stroke="hsl(var(--primary))" strokeWidth="1.5" fill="hsl(var(--primary) / 0.06)" />
              {/* Arrow */}
              <path d="M20 37 L20 34" stroke="hsl(var(--muted-foreground))" strokeWidth="1" strokeLinecap="round" />
            </svg>
          </div>
          {/* Pulse ring */}
          <div
            className="absolute inset-0 rounded-2xl animate-ping opacity-20"
            style={{ background: "hsl(var(--primary))", animationDuration: "2s" }}
          />
        </div>

        {/* Text */}
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-semibold text-foreground tracking-tight font-sans">
            Floor Plan → 3D
          </h1>
          <p className="text-sm text-muted-foreground font-mono">
            Upload · Detect · Generate
          </p>
        </div>

        {/* Progress bar */}
        <div className="w-48 h-px bg-border rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-100"
            style={{
              width: `${progress}%`,
              background: "hsl(var(--primary))",
              boxShadow: "0 0 8px hsl(var(--primary) / 0.6)",
            }}
          />
        </div>

        {/* Version */}
        <span className="text-[10px] text-muted-foreground font-mono opacity-60">v2.0 demo</span>
      </div>
    </div>
  );
};

export default SplashScreen;
