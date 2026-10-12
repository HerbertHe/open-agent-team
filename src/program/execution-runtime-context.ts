import { z } from "zod";
import {
  AttemptIdSchema,
  OpaqueIdSchema,
  ProgramIdSchema,
  WorkPackageIdSchema,
} from "./program-types";

export const ExecutionRuntimeContextSchema = z.object({
  programId: ProgramIdSchema,
  workPackageId: WorkPackageIdSchema,
  attemptId: AttemptIdSchema,
  executionEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  fencingToken: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  operationId: OpaqueIdSchema,
  reservationId: OpaqueIdSchema.optional(),
}).strict();

export type ExecutionRuntimeContext = z.infer<typeof ExecutionRuntimeContextSchema>;

export function roundTripExecutionRuntimeContext(input: ExecutionRuntimeContext): ExecutionRuntimeContext {
  const parsed = ExecutionRuntimeContextSchema.parse(input);
  return ExecutionRuntimeContextSchema.parse(JSON.parse(JSON.stringify(parsed)) as unknown);
}
