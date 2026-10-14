/** Translate raw LLM/API errors into user-friendly Persian messages. */

interface Rule { test: RegExp; message: string }

const RULES: Rule[] = [
  {
    test: /FreeTierError/i,
    message: "مدل رایگان OpenCode فعلاً از طریق API در دسترس نیست. از پنل مدیریت (تب «مدل‌ها») یه پروایدر دیگه انتخاب کن — مثلاً Gemini با کلید رایگان.",
  },
  {
    test: /401|unauthorized|invalid api key|invalid_api_key|authentication/i,
    message: "کلید API معتبر نیست. از پنل مدیریت (تب «مدل‌ها») کلید درست رو وارد کن.",
  },
  {
    test: /429|rate.?limit|too many requests|quota/i,
    message: "محدودیت نرخ API رد شده. چند دقیقه صبر کن و دوباره امتحان کن.",
  },
  {
    test: /model_not_found|does not exist|unknown model|404.*model/i,
    message: "اسم مدل اشتباهه یا دیگه وجود نداره. از پنل مدیریت مدل رو اصلاح کن.",
  },
  {
    test: /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i,
    message: "مشکل اتصال به سرویس مدل. اینترنت سرور یا آدرس API رو چک کن.",
  },
  {
    test: /overloaded|529|503|service unavailable/i,
    message: "سرویس مدل فعلاً شلوغه. چند لحظه دیگه امتحان کن.",
  },
  {
    test: /context.?length|too long|maximum context|token.?limit/i,
    message: "متن خیلی طولانیه و توی حافظه مدل جا نمی‌شه. خلاصه‌تر بفرست.",
  },
  {
    test: /content.?policy|blocked|harmful|safety/i,
    message: "این درخواست توسط فیلتر امنیتی مدل رد شد.",
  },
];

/** Short Persian explanation of what went wrong, safe to show the user. */
export function friendlyLlmError(e: unknown): string {
  const raw = e instanceof Error ? `${e.message} ${String((e as any).cause ?? "")}` : String(e ?? "");
  for (const r of RULES) if (r.test.test(raw)) return r.message;
  // Fallback: hide technical details, keep it short.
  const short = raw.replace(/\s+/g, " ").trim().slice(0, 160);
  return short ? `یه خطا پیش اومد (${short}). دوباره امتحان کن.` : "یه خطا پیش اومد. دوباره امتحان کن.";
}

/** One-line owner-facing summary: keeps the technical detail but in a compact form. */
export function ownerErrorSummary(event: string, e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  const short = raw.replace(/\s+/g, " ").trim().slice(0, 300);
  return `🚨 ${event}: ${friendlyLlmError(e)}${short ? `\nجزئیات: ${short}` : ""}`;
}
