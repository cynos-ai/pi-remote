import type { ExtensionUIContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { WidgetHost } from "./widget-host.js";

interface FooterData extends ReadonlyFooterDataProvider {
  setExtensionStatus(key: string, text: string | undefined): void;
  setAvailableProviderCount(count: number): void;
  dispose(): void;
}
// The provider implementation is internal to the pinned SDK; keep it here.
const footerModule = await import(new URL("./core/footer-data-provider.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  FooterDataProvider: new (cwd: string) => FooterData;
};
export type SurfaceMethod = "setHeader" | "setFooter";
type SurfaceFactory = NonNullable<Parameters<ExtensionUIContext["setFooter"]>[0]>;

/** One Session's non-interactive extension header/footer and native footer data. */
export class SurfaceHost {
  private readonly widgets = new WidgetHost();
  private readonly data: FooterData;
  private expanded = false;

  constructor(cwd: string) { this.data = new footerModule.FooterDataProvider(cwd); }

  set(method: SurfaceMethod, factory: SurfaceFactory | undefined, publish: (value: unknown) => void): void {
    if (!factory) { this.widgets.remove(method); publish(null); return; }
    this.widgets.set(method, (tui, theme) => {
      const component = factory(tui, theme, this.data);
      let appliedExpansion: boolean | undefined;
      return {
        render: width => {
          const expandable = component as typeof component & { setExpanded?(value: boolean): void };
          if (method === "setHeader" && appliedExpansion !== this.expanded) {
            appliedExpansion = this.expanded;
            expandable.setExpanded?.(this.expanded);
          }
          return component.render(width);
        },
        invalidate: () => component.invalidate(),
        dispose: () => component.dispose?.()
      };
    }, publish, error => publish({ rendererError: error instanceof Error ? error.message : String(error) }));
  }

  setStatus(key: string, text: string | undefined): void {
    this.data.setExtensionStatus(key, text);
    this.refresh();
  }

  update(providerCount: number, expanded: boolean): void {
    this.data.setAvailableProviderCount(providerCount);
    this.expanded = expanded;
    this.refresh();
  }

  private refresh(): void {
    this.widgets.refresh("setHeader");
    this.widgets.refresh("setFooter");
  }

  dispose(): void { this.widgets.dispose(); this.data.dispose(); }
}
