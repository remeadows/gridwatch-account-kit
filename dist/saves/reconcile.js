/** Spec §5.4 decision table. Revisions decide, never timestamps. Pure: no I/O, no DOM. */
export function decideReconcile(inputs) {
    const { signedIn, cloud, local, record, owner, userId } = inputs;
    if (!signedIn || !userId)
        return "signed_out";
    const ownedByOther = owner !== null && owner !== userId;
    if (cloud === null) {
        if (local === null)
            return "nothing";
        return ownedByOther ? "ownership_prompt" : "upload";
    }
    if (local === null)
        return "use_cloud";
    if (record === null || ownedByOther)
        return "conflict_prompt";
    if (record.revision === cloud.revision)
        return record.dirty ? "restore_dirty" : "current";
    if (record.revision < cloud.revision)
        return record.dirty ? "conflict_prompt" : "use_cloud";
    return "conflict_prompt";
}
