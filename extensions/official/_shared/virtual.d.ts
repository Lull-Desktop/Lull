declare module "virtual:lull-messages" {
  export const m: Record<
    string,
    (params?: Record<string, unknown>) => string
  >;
  export function setLocale(locale: string): void;
}
