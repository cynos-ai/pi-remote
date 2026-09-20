import { CURSOR_MARKER, TuiMainScreen } from "@earendil-works/pi-tui";
import { createTextTerminal, renderTextComponent } from "./widget-host.js";

/** Native focus, input listeners and overlay composition on a virtual terminal. */
export class CustomTextTui extends TuiMainScreen {
  readonly deliverInput: (data: string) => void;

  constructor(render: () => void) {
    const terminal = createTextTerminal();
    let input: ((data: string) => void) | undefined;
    terminal.start = handler => { input = handler; };
    terminal.stop = () => { input = undefined; };
    super(terminal);
    this.requestRender = render;
    this.deliverInput = data => input?.(data);
  }

  override renderNow(): void { this.requestRender(); }

  renderFrame(): string[] {
    return renderTextComponent({
      render: width => this.compositeOverlays(this.render(width), width, this.terminal.rows).map(line => line.replaceAll(CURSOR_MARKER, "")),
      invalidate() {}
    });
  }
}
