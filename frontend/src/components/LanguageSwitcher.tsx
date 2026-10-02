import { Globe2 } from "lucide-react";
import "./LanguageSwitcher.css";

export type Language = "th" | "en";

export default function LanguageSwitcher({ language, onChange }: { language: Language; onChange: (language: Language) => void }) {
  return <div className="language-switcher" role="group" aria-label="Language / ภาษา" data-language={language}>
    <Globe2 size={13} aria-hidden="true" />
    <div className="language-options"><span className="language-selection" aria-hidden="true" />
      <button type="button" lang="th" aria-pressed={language === "th"} onClick={() => onChange("th")}>ไทย</button>
      <button type="button" lang="en" aria-pressed={language === "en"} onClick={() => onChange("en")}>EN</button>
    </div>
  </div>;
}
