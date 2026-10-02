import { CircleCheck, CircleAlert, TriangleAlert, Info } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Toast, ToastClose, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from "@/components/ui/toast";

export function Toaster() {
  const { toasts } = useToast();

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, ...props }) {
        const Icon = props.variant === "success" ? CircleCheck : props.variant === "destructive" ? CircleAlert : props.variant === "warning" ? TriangleAlert : Info;
        return (
          <Toast key={id} {...props}>
            <span className="glass-toast-icon" aria-hidden="true"><Icon size={19} strokeWidth={1.8} /></span>
            <div className="grid min-w-0 flex-1 gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && <ToastDescription>{description}</ToastDescription>}
            </div>
            {action}
            <ToastClose />
          </Toast>
        );
      })}
      <ToastViewport />
    </ToastProvider>
  );
}
