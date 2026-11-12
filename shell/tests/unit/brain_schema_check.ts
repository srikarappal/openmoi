// What the brain sends, as its own models say (src/shared/brain_schema.ts, generated), must fit the types the shell
// reads it with: tsc fails here when a field is renamed, retyped or dropped on either side.
import type * as Sent from "../../src/shared/brain_schema"
import type * as Read from "../../src/shared/types"

type Fits<Brain, Shell> = [Brain] extends [Shell] ? true : false

export const replies_fit: Array<true> = [
  true as Fits<Sent.ViewPage, Read.ViewPage>,
  true as Fits<Sent.ViewSchedule, Read.ViewSchedule>,
  true as Fits<Sent.ActionDecision, Read.ActionDecision>,
  true as Fits<Sent.AgentRun, Read.AgentRun>,
  true as Fits<Sent.Proposal, Read.Proposal>,
  true as Fits<Sent.LookupStart, Read.LookupStart>,
  true as Fits<Sent.PeopleReply, Read.PeopleReply>,
  true as Fits<Sent.AppAccess, Read.AppAccess>,
  true as Fits<Sent.ShopStart, Read.ShopStart>,
  true as Fits<Sent.CollectionInfo, Read.CollectionInfo>,
  true as Fits<Sent.SearchHit, Read.SearchHit>,
]
