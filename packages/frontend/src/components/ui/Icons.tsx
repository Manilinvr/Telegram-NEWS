import type { SVGProps } from 'react';

/**
 * Набор иконок.
 *
 * Иконки встроены как SVG-компоненты, а не подключаются библиотекой:
 * приватная панель не должна тянуть шрифты и ресурсы со сторонних CDN,
 * а нужный набор невелик.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 18, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const IconHome = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" />
  </Icon>
);

export const IconFeed = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 9h10M7 13h10M7 17h6" />
  </Icon>
);

export const IconEvents = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
    <circle cx="12" cy="12" r="4" />
  </Icon>
);

export const IconAnalytics = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 20h18" />
    <rect x="5" y="11" width="3.5" height="6" rx="1" />
    <rect x="10.5" y="7" width="3.5" height="10" rx="1" />
    <rect x="16" y="13" width="3.5" height="4" rx="1" />
  </Icon>
);

export const IconSources = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
    <path d="M6.5 6.5 8.6 8.6M15.4 15.4l2.1 2.1M17.5 6.5l-2.1 2.1M8.6 15.4l-2.1 2.1" />
  </Icon>
);

export const IconMap = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 4 3 6.5v13L9 17l6 2.5 6-2.5v-13L15 7 9 4Z" />
    <path d="M9 4v13M15 7v12.5" />
  </Icon>
);

export const IconSettings = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .33 1.76l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.76-.33 1.6 1.6 0 0 0-1 1.46V21a2 2 0 1 1-4 0v-.11a1.6 1.6 0 0 0-1-1.46 1.6 1.6 0 0 0-1.77.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.6 1.6 0 0 0 .33-1.76 1.6 1.6 0 0 0-1.46-1H3a2 2 0 1 1 0-4h.11a1.6 1.6 0 0 0 1.46-1 1.6 1.6 0 0 0-.33-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.76.33H9a1.6 1.6 0 0 0 1-1.46V3a2 2 0 1 1 4 0v.11a1.6 1.6 0 0 0 1 1.46 1.6 1.6 0 0 0 1.76-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.33 1.76V9a1.6 1.6 0 0 0 1.46 1H21a2 2 0 1 1 0 4h-.11a1.6 1.6 0 0 0-1.46 1Z" />
  </Icon>
);

export const IconModeration = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3 4 6.2v5.4c0 4.4 3.2 8.5 8 9.4 4.8-.9 8-5 8-9.4V6.2L12 3Z" />
    <path d="m9 12 2 2 4-4" />
  </Icon>
);

export const IconPublished = (p: IconProps) => (
  <Icon {...p}>
    <path d="m21 3-9.5 9.5" />
    <path d="M21 3 14.5 21l-3-7.5L4 10.5 21 3Z" />
  </Icon>
);

export const IconSearch = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Icon>
);

export const IconPhoto = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <circle cx="8.5" cy="10" r="1.5" />
    <path d="m4 17 5-4.5 4 3.5 3-2.5 4 3.5" />
  </Icon>
);

export const IconVideo = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="6" width="12" height="12" rx="2" />
    <path d="m15 10.5 6-3v9l-6-3v-3Z" />
  </Icon>
);

export const IconTranscript = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </Icon>
);

export const IconSourceCount = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="3.2" />
    <circle cx="16" cy="16" r="3.2" />
    <path d="M10.6 10.6 13.4 13.4" />
  </Icon>
);

export const IconLocation = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z" />
    <circle cx="12" cy="10" r="2.6" />
  </Icon>
);

export const IconClock = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.2 2" />
  </Icon>
);

export const IconClose = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Icon>
);

export const IconBack = (p: IconProps) => (
  <Icon {...p}>
    <path d="M19 12H5M11 18l-6-6 6-6" />
  </Icon>
);

export const IconCheck = (p: IconProps) => (
  <Icon {...p}>
    <path d="m4 12.5 5 5L20 6.5" />
  </Icon>
);

export const IconRefresh = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 11a8 8 0 1 0-1.6 5.4" />
    <path d="M20 4v7h-7" />
  </Icon>
);

export const IconSave = (p: IconProps) => (
  <Icon {...p}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
    <path d="M17 21v-8H7v8M7 3v5h8" />
  </Icon>
);

export const IconEye = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);

export const IconWarning = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10.3 4.3 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9.5v4M12 17h.01" />
  </Icon>
);

export const IconError = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5M12 16h.01" />
  </Icon>
);

export const IconMenu = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);

export const IconLogout = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="M16 17l5-5-5-5M21 12H9" />
  </Icon>
);

export const IconPlus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const IconTelegram = (p: IconProps) => (
  <Icon {...p}>
    <path d="M21.5 4.3 2.9 11.2c-.9.3-.9 1.6.1 1.8l4.7 1.2 1.8 5.4c.2.7 1.1.8 1.6.3l2.5-2.4 4.7 3.4c.6.4 1.4.1 1.6-.6l3-14.5c.2-.9-.7-1.6-1.4-1.5Z" />
    <path d="m7.7 14.2 10.6-7.4-8 8.6" />
  </Icon>
);

export const IconVk = (p: IconProps) => (
  <Icon {...p} strokeWidth={1.6}>
    <path d="M4 7c.4 4.6 3 8.3 7.4 8.3h.6v-3c1.6.2 2.9 1.4 3.4 3H18c-.6-2.2-2.2-3.5-3.2-4 1-.6 2.4-2.1 2.7-4.3h-2.3c-.4 1.8-1.7 3.2-2.6 3.4V7H10v5c-1.2-.3-2.6-2.4-2.7-5H4Z" />
  </Icon>
);

export const IconShield = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3 4 6.2v5.4c0 4.4 3.2 8.5 8 9.4 4.8-.9 8-5 8-9.4V6.2L12 3Z" />
  </Icon>
);

export const IconSpark = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21" />
    <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />
  </Icon>
);

export const IconDatabase = (p: IconProps) => (
  <Icon {...p}>
    <ellipse cx="12" cy="6" rx="8" ry="3" />
    <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
    <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
  </Icon>
);
