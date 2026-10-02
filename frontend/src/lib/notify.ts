import { toast } from "@/hooks/use-toast";

export function notificationText(en: string, th: string) {
  try { return (localStorage.getItem("app-language") ?? localStorage.getItem("login-language")) === "th" ? th : en; }
  catch { return en; }
}

export function notify(kind: "success" | "destructive" | "warning", title: string, description: string) {
  return toast({ variant: kind, title, description, duration: kind === "success" ? 4500 : 8000 });
}

export function notifyAuthError(message: string) {
  const translations: Record<string, string> = {
    "Unable to sign in. Check your username and password.": "กรุณาตรวจสอบชื่อผู้ใช้และรหัสผ่าน แล้วลองอีกครั้ง",
    "Too many attempts. Try again in 15 minutes.": "ลองเข้าสู่ระบบหลายครั้งเกินไป กรุณารอ 15 นาทีแล้วลองใหม่",
    "Unable to reach the sign-in service. Please retry.": "เชื่อมต่อระบบไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง",
    "The sign-in service did not respond. Please retry.": "ระบบไม่ตอบสนอง กรุณาลองอีกครั้ง",
    "Google sign-in was not completed or this account is not allowed.": "เข้าสู่ระบบด้วย Google ไม่สำเร็จ หรือบัญชีนี้ไม่ได้รับอนุญาต",
    "Logout failed. Please try again.": "ออกจากระบบไม่สำเร็จ กรุณาลองอีกครั้ง",
  };
  return notify("destructive", notificationText("Something went wrong", "ดำเนินการไม่สำเร็จ"), notificationText(message, translations[message] ?? "เชื่อมต่อระบบไม่ได้ กรุณาลองอีกครั้ง"));
}
