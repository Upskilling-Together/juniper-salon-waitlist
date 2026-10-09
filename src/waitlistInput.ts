// Validation for the staff "Add to waitlist" form. Pure (no I/O) so the API can give field
// errors up front and the waitlist Workflow's Update validator can enforce the same rules.
import {
  SERVICES,
  STYLISTS,
  TEXTING_CONSENTS,
  type AddClientInput,
  type Service,
  type Stylist,
  type StylistRule,
  type TextingConsent,
} from "./types";

export const NAME_MAX = 80;
export const NOTE_MAX = 300;

/** "(555) 010-0125" for 10-digit numbers (or 11 starting with 1); other lengths are kept as typed. */
export function formatMobile(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length === 10) return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
  return raw.trim();
}

export const mobileDigits = (m: string) => {
  const d = m.replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
};

export type CheckedAddClient =
  | { ok: true; value: AddClientInput }
  | { ok: false; errors: { field: keyof AddClientInput; message: string }[] };

/** Validate and tidy what staff typed. The availability note is kept verbatim (only trimmed). */
export function checkAddClientInput(raw: unknown): CheckedAddClient {
  const body = (raw ?? {}) as Record<string, unknown>;
  const errors: { field: keyof AddClientInput; message: string }[] = [];
  const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
  if (!name) errors.push({ field: "name", message: "Enter their name." });
  else if (name.length > NAME_MAX) errors.push({ field: "name", message: `Name must be ${NAME_MAX} characters or fewer.` });

  const mobileRaw = typeof body.mobile === "string" ? body.mobile : "";
  const digits = mobileDigits(mobileRaw);
  if (!mobileRaw.trim()) errors.push({ field: "mobile", message: "Enter their mobile number." });
  else if (digits.length < 10 || digits.length > 15) errors.push({ field: "mobile", message: "Enter a valid mobile number." });

  const service = body.service as Service;
  if (!SERVICES.includes(service)) errors.push({ field: "service", message: `Choose a service (${SERVICES.join(", ")}).` });

  let stylistRule: StylistRule | undefined;
  const rule = (body.stylistRule ?? {}) as Record<string, unknown>;
  if (rule.kind === "required") {
    if (STYLISTS.includes(rule.stylist as Stylist)) stylistRule = { kind: "required", stylist: rule.stylist as Stylist };
    else errors.push({ field: "stylistRule", message: "Choose which stylist they need." });
  } else if (rule.kind === "any") {
    if (rule.preferred == null || rule.preferred === "") stylistRule = { kind: "any" };
    else if (STYLISTS.includes(rule.preferred as Stylist)) stylistRule = { kind: "any", preferred: rule.preferred as Stylist };
    else errors.push({ field: "stylistRule", message: "Choose a valid preferred stylist." });
  } else {
    errors.push({ field: "stylistRule", message: "Choose Any stylist or Only a specific stylist." });
  }

  const note = body.availabilityNote == null ? "" : body.availabilityNote;
  if (typeof note !== "string") errors.push({ field: "availabilityNote", message: "Availability must be text." });
  else if (note.trim().length > NOTE_MAX) {
    errors.push({ field: "availabilityNote", message: `Availability must be ${NOTE_MAX} characters or fewer.` });
  }

  const textingConsent = body.textingConsent as TextingConsent;
  if (!TEXTING_CONSENTS.includes(textingConsent)) {
    errors.push({ field: "textingConsent", message: "Answer “Can we text them about earlier openings?” (Yes, No or Didn't ask)." });
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      mobile: formatMobile(mobileRaw),
      service,
      stylistRule: stylistRule!,
      availabilityNote: (note as string).trim(),
      textingConsent,
    },
  };
}
