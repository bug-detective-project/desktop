/** Line icons from lucide-react. They draw with currentColor, so they take the text color around them. */
import {
  ArrowLeft,
  ArrowRight,
  Briefcase,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheckBig,
  CircleQuestionMark,
  ClipboardList,
  Code,
  Globe,
  Contact,
  Download,
  ExternalLink,
  HardDrive,
  Inbox,
  Info,
  Laptop,
  LoaderCircle,
  Mail,
  Moon,
  Package,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Server,
  Settings,
  SquareKanban,
  Sun,
  Trash2,
  TriangleAlert,
  Users,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const ICONS = {
  mail: Mail,
  board: SquareKanban,
  settings: Settings,
  check: Check,
  checkCircle: CircleCheckBig,
  arrowRight: ArrowRight,
  arrowLeft: ArrowLeft,
  chevronDown: ChevronDown,
  externalLink: ExternalLink,
  download: Download,
  alertTriangle: TriangleAlert,
  alertCircle: CircleAlert,
  spinner: LoaderCircle,
  refresh: RefreshCw,
  code: Code,
  play: Play,
  pause: Pause,
  globe: Globe,
  server: Server,
  hardDrive: HardDrive,
  info: Info,
  helpCircle: CircleQuestionMark,
  laptop: Laptop,
  sun: Sun,
  moon: Moon,
  rotateCcw: RotateCcw,
  trash: Trash2,
  x: X,
  // The Dashboard's work desk.
  clipboardList: ClipboardList,
  package: Package,
  users: Users,
  briefcase: Briefcase,
  contact: Contact,
  inbox: Inbox,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, className = 'size-4' }: { name: IconName; className?: string }) {
  const Lucide = ICONS[name];
  return (
    <Lucide
      className={`shrink-0 ${name === 'spinner' ? 'animate-spin' : ''} ${className}`}
      strokeWidth={name === 'check' ? 2.5 : 2}
      aria-hidden
    />
  );
}
