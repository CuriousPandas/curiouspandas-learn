// The dashboard that lies, as a model (TemplateMechanics/tilt lab 08).
//
// A ServiceMonitor selects *Services* by label, then names a port *by name*.
// Get either wrong and the Prometheus Operator generates no scrape target and
// considers nothing to have failed: the object is accepted, the pods are Ready,
// and the panel simply has no data. The only place the truth appears is
// Prometheus's own targets page. This file models exactly those rules; it does
// not model Prometheus staleness timing (deliberately - see the lesson).

export type Service = { name: string; labels: Record<string, string>; ports: { name: string; port: number; targetPort: number }[] };
export type ServiceMonitor = { selectorKey: string; selectorValue: string; port: string };
export type Target = { service: string; endpoint: string; health: 'up' };

// As in examples/hello-world: Service port 80 named http, forwarding to the
// pod's 9898. The pod IP is illustrative.
export const HELLO: Service = { name: 'hello', labels: { 'app.kubernetes.io/name': 'hello' }, ports: [{ name: 'http', port: 80, targetPort: 9898 }] };
const POD_IP = '10.244.1.12';

export function targets(services: Service[], sm: ServiceMonitor): Target[] {
  // Prometheus scrapes the pod behind the Service, on the target port: the
  // Service port's name is only how the ServiceMonitor finds it.
  return services
    .filter((s) => s.labels[sm.selectorKey] === sm.selectorValue)
    .flatMap((s) => s.ports.filter((p) => p.name === sm.port).map((p) => ({ service: s.name, endpoint: `http://${POD_IP}:${p.targetPort}/metrics`, health: 'up' as const })));
}

/** What `kubectl get servicemonitor` and `kubectl get pods` say. Always fine - that is the trap. */
export function kubernetesView(_sm: ServiceMonitor) {
  return { servicemonitorExists: true, events: 0, podsReady: '1/1' };
}

export class Scraper {
  tick = 0;
  sm: ServiceMonitor;
  services: Service[];
  series: { tick: number; value: number }[] = [];
  lastScrape: number | null = null;
  private seed = 7;

  constructor(sm: ServiceMonitor, services: Service[] = [HELLO]) { this.sm = sm; this.services = services; }

  private rand() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }

  step(n = 1) {
    for (let i = 0; i < n; i++) {
      this.tick++;
      if (targets(this.services, this.sm).length) {
        this.lastScrape = this.tick;
        this.series.push({ tick: this.tick, value: 4 + Math.sin(this.tick / 3) * 1.5 + this.rand() });
      }
      if (this.series.length > 120) this.series.shift();
    }
  }

  /** The panel shows only samples from currently scraped targets: once the target is gone there is no line to draw. */
  panel(window = 30): { tick: number; value: number }[] {
    if (!targets(this.services, this.sm).length) return [];
    return this.series.filter((p) => p.tick > this.tick - window);
  }
}
