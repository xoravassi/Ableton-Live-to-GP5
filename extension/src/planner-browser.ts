import { planTrack } from "./export-planner.js";

(globalThis as typeof globalThis & {
  abletonToGp5Planner?: {
    planTrack: typeof planTrack;
  };
}).abletonToGp5Planner = {
  planTrack,
};
