import { useQuery } from "../../api/client";
import { useNavProject } from "../../api/scope";

/** Counts for the tabs and the stopped rows; one cache entry for the toolbar, the badge and the Stopped tab. */
export const useSummary = () => useQuery("needs:summary", (api) => api.needs({}));

/** The summary for the navigation badge: the page's project, or the pick where the page has none. */
export const useNavSummary = () => useQuery("needs:summary", (api) => api.needs({}), { project: useNavProject() });
