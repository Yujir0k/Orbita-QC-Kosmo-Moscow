import { useEffect, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Activity, ArrowDownUp, ArrowRight, Bell, BookOpen, Box, Boxes, BrainCircuit, Camera, Check, CheckCheck, ChevronRight, CircleDot, ClipboardCheck, Clock3, Cpu, Database, Factory, FileText, FlaskConical, Gauge, GitBranch, HelpCircle, Home, Layers3, ListChecks, LockKeyhole, Microscope, Network, Orbit, Radio, Search, Settings2, ShieldCheck, Sparkles, TriangleAlert, Truck, Users, Workflow, X, type LucideIcon } from 'lucide-react';
export const icons: Record<string, LucideIcon> = { home: Home, quality: ClipboardCheck, production: Factory, products: Box, investigation: Microscope, tasks: ListChecks, analytics: Gauge, control: Camera, models: BrainCircuit, forecast: Sparkles, mobile: Truck, integrations: ArrowDownUp, events: Activity, security: ShieldCheck, platform: Settings2, guide: Network, arrow: ArrowRight, chevron: ChevronRight, close: X, check: Check, done: CheckCheck, clock: Clock3, alert: TriangleAlert, source: Radio, database: Database, layer: Layers3, branch: GitBranch, users: Users, flow: Workflow, search: Search, bell: Bell, orbit: Orbit, help: HelpCircle, cpu: Cpu, lock: LockKeyhole, file: FileText, book: BookOpen, box: Boxes, dot: CircleDot, flask: FlaskConical };
export function Icon({ name, size = 18, className = '' }: { name: string; size?: number; className?: string }) { const Component = icons[name] ?? CircleDot; return <Component size={size} strokeWidth={1.65} className={className} aria-hidden="true" />; }
export function ImageLightbox({ src, alt, title, onClose }: { src: string; alt: string; title?: string; onClose: () => void }) {
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [contrast, setContrast] = useState(false);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, [onClose]);
  const center = () => { setPosition({ x: 0, y: 0 }); setZoom(1); };
  const startDrag = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (zoom <= 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragStart({ x: event.clientX - position.x, y: event.clientY - position.y });
  };
  const moveDrag = (event: ReactPointerEvent<HTMLImageElement>) => { if (dragStart) setPosition({ x: event.clientX - dragStart.x, y: event.clientY - dragStart.y }); };
  return <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={`Просмотр фото: ${alt}`} onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <div className="image-lightbox-panel">
      <header><div><span className="image-lightbox-kicker">ДЕТАЛЬНЫЙ ПРОСМОТР</span><strong>{title ?? alt}</strong></div><button type="button" className="icon-button" aria-label="Закрыть просмотр" onClick={onClose}><Icon name="close" size={23}/></button></header>
      <div className="image-lightbox-stage"><img src={src} alt={alt} draggable={false} className={contrast ? 'is-contrast' : ''} style={{ transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})` }} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={() => setDragStart(null)} onPointerCancel={() => setDragStart(null)} /></div>
      <footer className="image-lightbox-controls">
        <button type="button" onClick={() => setZoom(value => Math.max(1, value - .25))} aria-label="Уменьшить">−</button><span>Зум {Math.round(zoom * 100)}%</span><button type="button" onClick={() => setZoom(value => Math.min(4, value + .25))} aria-label="Увеличить">+</button>
        <button type="button" onClick={center} aria-label="Вернуть фото в центр и сбросить масштаб" title="Вернуть фото в центр и сбросить масштаб">В центр · 100%</button><button type="button" aria-pressed={contrast} onClick={() => setContrast(value => !value)}>Контраст</button><button type="button" className="image-lightbox-close" onClick={onClose}>Закрыть</button>
      </footer>
    </div>
  </div>;
}
export function ImagePreview({ src, alt, title, className = '' }: { src: string; alt: string; title?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className={`image-preview ${className}`} aria-label={`Открыть изображение крупно: ${alt}`} onClick={() => setOpen(true)}><img src={src} alt={alt}/><span>Открыть крупно</span></button>{open && <ImageLightbox src={src} alt={alt} title={title} onClose={() => setOpen(false)}/>}</>;
}
export function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: string }) { return <span className={`badge ${tone}`}><i />{children}</span>; }
export function Button({ children, onClick, primary = false, icon = 'arrow', className = '', disabled = false }: { children: ReactNode; onClick?: () => void; primary?: boolean; icon?: string; className?: string; disabled?: boolean }) { return <button type="button" className={`button ${primary ? 'primary' : ''} ${className}`} onClick={onClick} disabled={disabled}>{children}{icon && <Icon name={icon} size={16} />}</button>; }
export function Panel({ title, eyebrow, children, action, className = '' }: { title: string; eyebrow?: string; children: ReactNode; action?: ReactNode; className?: string }) { return <section className={`panel ${className}`}><div className="panel-heading"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2></div>{action}</div>{children}</section>; }
export function Note({ children, tone = 'blue', icon = 'help' }: { children: ReactNode; tone?: string; icon?: string }) { return <div className={`note ${tone}`}><Icon name={icon} size={18} /><div>{children}</div></div>; }
export function Empty({ title, text, action }: { title: string; text: string; action?: ReactNode }) { return <div className="empty"><span className="empty-icon"><Icon name="layer" size={28} /></span><h3>{title}</h3><p>{text}</p>{action}</div>; }
export function Metric({ label, value, note, icon, tone = 'blue', onClick }: { label: string; value: string | number; note: string; icon: string; tone?: string; onClick?: () => void }) { const Tag = onClick ? 'button' : 'div'; return <Tag className={`metric ${tone}`} onClick={onClick}><div className="metric-top"><span>{label}</span><Icon name={icon} size={19} /></div><strong>{value}</strong><small>{note}</small>{onClick && <Icon name="arrow" size={16} className="metric-arrow" />}</Tag>; }
export function ProductDrawing({ compact = false }: { compact?: boolean }) { return <svg className={`product-drawing ${compact ? 'compact' : ''}`} viewBox="0 0 340 190" role="img" aria-label="Условная схема кронштейна, не CAD-геометрия"><defs><linearGradient id="body-fill" x2="1" y2="1"><stop stopColor="#6d8797" stopOpacity=".16"/><stop offset="1" stopColor="#a6c3d4" stopOpacity=".03"/></linearGradient></defs><g fill="none" stroke="#334450" strokeWidth=".6"><path d="M10 140H325M22 80H320M60 30V178M280 22V170" strokeDasharray="3 6"/><ellipse cx="170" cy="149" rx="135" ry="32"/></g><g stroke="#a7c3d4" strokeWidth="1.2" strokeLinejoin="round" fill="url(#body-fill)"><path d="M76 122l105 38 82-46-105-38z"/><path d="M76 122v13l105 38v-13m0 13 82-46v-13"/><path d="M130 98V40l51 18v61l-24 15z"/><path d="M130 40l33-18 51 18-33 18m0 61 33-19V40"/><path d="M194 137l34-19v-12l-34 19z"/><ellipse cx="155" cy="69" rx="8" ry="12" transform="rotate(-18 155 69)"/><ellipse cx="121" cy="126" rx="9" ry="4"/><ellipse cx="216" cy="120" rx="9" ry="4"/></g><g stroke="#739daf" strokeWidth=".75" fill="none"><path d="M58 148l106 38m-111-43 10 10m96 28 10 10M230 33h40l18-15M85 104H40L22 89"/></g><g fill="#8fa7b5" fontFamily="monospace" fontSize="8"><text x="274" y="15">REV. A</text><text x="8" y="85">BODY</text><text x="225" y="177">SCHEMATIC</text></g></svg>; }
