import { useId } from "react";

/** Native scalable illustration: the lid follows persisted chest state, never local optimism. */
export function TableArt({ open, disturbed }: { open: boolean; disturbed: boolean }) {
  const id = useId().replaceAll(":", "");
  return (
    <svg
      className={`heist-table-art${open ? " is-open" : ""}${disturbed ? " is-disturbed" : ""}`}
      viewBox="0 0 660 470"
      role="img"
      aria-label={open ? "The dragon's treasure chest is open" : "A dragon curled around a locked treasure chest"}
    >
      <defs>
        <radialGradient id={`${id}-halo`}>
          <stop stopColor="#d8a84c" stopOpacity=".23" />
          <stop offset="1" stopColor="#d8a84c" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-scales`} x2=".8" y2="1">
          <stop stopColor="#516863" />
          <stop offset=".48" stopColor="#273f3d" />
          <stop offset="1" stopColor="#101f20" />
        </linearGradient>
        <linearGradient id={`${id}-wood`} x2="0" y2="1">
          <stop stopColor="#75513b" />
          <stop offset="1" stopColor="#32291f" />
        </linearGradient>
        <linearGradient id={`${id}-gold`} x2=".3" y2="1">
          <stop stopColor="#f0d491" />
          <stop offset=".45" stopColor="#bd9147" />
          <stop offset="1" stopColor="#725426" />
        </linearGradient>
      </defs>
      <ellipse cx="335" cy="283" rx="269" ry="179" fill={`url(#${id}-halo)`} />
      <g fill="none" stroke="#bb9453" opacity=".21">
        <ellipse cx="331" cy="310" rx="222" ry="115" />
        <ellipse cx="331" cy="310" rx="204" ry="105" strokeDasharray="2 13" />
        <path d="M109 310H83m470 0h25M331 195v-23m0 253v20M177 229l-17-13m323 179 17 13M488 231l18-13M172 391l-20 16" />
      </g>
      <ellipse cx="337" cy="342" rx="165" ry="49" fill="#070d0e" opacity=".5" />
      <g className="heist-dragon" stroke="#769083" strokeWidth="1.2" strokeLinejoin="round">
        <path
          d="M164 292C53 302 66 152 143 119c71-30 139 2 168 64 29 63 91 91 168 44 71-43 96 28 38 70 83-17 93-119 28-136-74-19-88 52-139 24C348 74 202 39 111 92 14 148 12 305 138 337Z"
          fill={`url(#${id}-scales)`}
        />
        <path d="m166 113 7-39 27 33 17-46 23 49 28-32 5 53 37-18-9 44 42-5-19 35" fill="#b69b66" stroke="#574e36" />
        <path d="M178 145C152 96 109 74 63 78l44 39-44 22 52 13-25 33 53-4-2 30 48-24Z" fill="#263b3a" />
        <path d="m179 157-72-40m69 48-61-13m65 20-37 9" fill="none" opacity=".65" />
        <path d="M176 184c-20 7-39 35-34 61l-37 26 5 26 57 10 48-24 11-37-17-36Z" fill={`url(#${id}-scales)`} />
        <path d="m153 227-24-35 3 46m63-14 23-37 1 52" fill="#c7b082" stroke="#716044" />
        <path d="M110 278c21 9 43 11 62 2m-52 11 6 7 9-4m43-12 10 11 7-9" fill="none" />
        <path d="m149 252 22-5" className="heist-dragon-eye" stroke="#e8bf6b" strokeWidth="3" strokeLinecap="round" />
        <path d="m152 245 18 2" fill="none" stroke="#263b35" strokeWidth="4" />
        <path
          d="M267 225c-39-23-65 5-61 30l40 28 44-3-8-16-33-4 12-10m162-4 37 31-5 23-43 8-15-17 29-6-16-17"
          fill={`url(#${id}-scales)`}
        />
        <path d="m242 281 6-12m8 12 6-11m166 26-9-12m22 9-7-11" stroke="#cbb786" strokeWidth="3" />
        <path
          d="M90 197c-15 33-8 65 9 84m48-158 9 15m31-18 7 13m22-4 7 13m21-2 8 14m27 1 7 14m33 12 2 13m46 6-3 13m39-13 2 13m37-24 6 10m30-25 9 9"
          fill="none"
          opacity=".55"
        />
      </g>
      <g className="heist-chest" stroke="#a8874d" strokeLinejoin="round">
        <path d="m240 292 100-33 119 35-10 79-111 40-95-38Z" fill={`url(#${id}-wood)`} strokeWidth="2" />
        <path d="m338 321 121-27-10 79-111 40Z" fill="#302923" />
        <path d="m247 326 89 29m-87-7 87 29m9-23 105-33m-105 53 102-34" fill="none" stroke="#161e1b" opacity=".7" />
        <path d="m260 300 4 79 16 7-3-80m121-29-7 113 17-6 11-100" fill={`url(#${id}-gold)`} />
        <path d="m242 362 96 35 111-37-1 13-110 40-95-38Z" fill={`url(#${id}-gold)`} />
        <g className="heist-treasure" fill="#ebc46f">
          <ellipse cx="343" cy="294" rx="92" ry="31" fill="#dab35a" opacity=".35" />
          <circle cx="303" cy="298" r="11" />
          <circle cx="326" cy="289" r="13" />
          <circle cx="353" cy="301" r="12" />
          <circle cx="377" cy="290" r="10" />
          <path d="m340 259 13 16-11 16-12-16Z" fill="#b8d9cb" />
        </g>
        <g className="heist-chest-lid">
          <path d="M238 292c-4-55 37-80 99-70 60-15 109 20 124 72l-123 38Z" fill={`url(#${id}-wood)`} strokeWidth="2" />
          <path d="M268 280c0-31 22-53 39-58l17 1c-26 15-37 29-37 51Z" fill={`url(#${id}-gold)`} />
          <path d="M397 244c19 10 30 30 33 57l18-5c-4-27-20-54-42-61Z" fill={`url(#${id}-gold)`} />
          <path d="m238 283 100 33 121-31 2 13-123 37-100-35Z" fill={`url(#${id}-gold)`} />
          <path d="m328 320 20 1v30l-10 8-10-11Z" fill={`url(#${id}-gold)`} />
          <circle cx="338" cy="336" r="3" fill="#1a2220" />
          <path d="m338 337-2 8h4Z" fill="#1a2220" />
        </g>
        <g fill="#dfbd79">
          <circle cx="256" cy="364" r="2" />
          <circle cx="282" cy="375" r="2" />
          <circle cx="420" cy="375" r="2" />
          <circle cx="438" cy="369" r="2" />
        </g>
      </g>
      <g fill="#c7a65d" opacity=".65">
        <path d="m199 350 8 4-3 5-9-3Zm290-20 11 2-4 6-10-2ZM282 413l10-3 6 4-9 4Zm139-13 9-5 7 3-11 6Z" />
      </g>
    </svg>
  );
}

export function Rune({ index }: { index: number }) {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="17" fill="none" stroke="currentColor" opacity=".3" strokeDasharray="1 4" />
      <path
        d={
          index === 0
            ? "M20 7v26M11 14l9-7 9 7-9 8-9-8m9 8 9 8"
            : index === 1
              ? "m11 9 18 11-18 11V9m18 0L11 20l18 11V9"
              : "M20 6 9 20l11 14 11-14L20 6m0 0v28M9 20h22"
        }
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
