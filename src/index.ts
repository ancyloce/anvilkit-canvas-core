import { z } from "zod";

export const CANVAS_CORE_VERSION = "0.1.0";

export const CanvasIRStub = z.object({
	version: z.literal("0.0.0"),
});

export type CanvasIRStubShape = z.infer<typeof CanvasIRStub>;
