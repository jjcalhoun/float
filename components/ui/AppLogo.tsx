/* The Float mark — a sailboat on marine blue, white sail, teal waterline.
 *
 * This is the same drawing as public/brand/float-mark.svg, which is what
 * scripts/make-icons.mjs rasterises into the PWA icons and the favicon.
 * Inline here so it stays crisp at any size and picks up no network request;
 * if you change one, change the other and re-run the script.
 *
 * Callers control size + corner rounding (wrap with overflow-hidden). */
export function AppLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <rect width="512" height="512" fill="#0B3D5C" />
      {/* mainsail and jib, split by the gap that reads as the mast */}
      <path d="M272 92 L272 300 L394 300 Z" fill="#FFFFFF" />
      <path d="M242 128 L242 300 L146 300 Z" fill="#FFFFFF" />
      <path d="M112 318 L404 318 L344 396 Q256 410 172 396 Z" fill="#FFFFFF" />
      <path d="M96 424 H416" stroke="#14B8A6" strokeWidth="26" strokeLinecap="round" fill="none" />
      <path d="M148 470 H364" stroke="#14B8A6" strokeWidth="26" strokeLinecap="round" fill="none" />
    </svg>
  );
}
