export function selectAgentTours(agentId, records) {
  const tours = records.map((record) => record.tour).filter((tour) => tour.agentId === agentId)
    .sort((a, b) => String(b.completedAt || b.cancelledAt || b.startedAt).localeCompare(String(a.completedAt || a.cancelledAt || a.startedAt)));
  return {
    activeTour: tours.find((tour) => tour.status === "active") || null,
    history: tours.filter((tour) => tour.status !== "active").slice(0, 25)
  };
}

export function createTourSync({ store, send, getSession, isOnline = () => true, onStatus = () => {}, onAuthRejected = () => {} }) {
  let writeTail = Promise.resolve();
  let flushPromise;

  function enqueue(tour) {
    const write = writeTail.then(() => store.put(tour));
    writeTail = write.catch(() => {});
    return write;
  }

  function flush() {
    if (flushPromise) return flushPromise;
    flushPromise = (async () => {
      while (true) {
        const observedWrites = writeTail;
        await observedWrites;
        const session = getSession();
        if (!session?.agentId || !session.credentials || !isOnline()) return;
        const records = await store.all();
        if (getSession() !== session || writeTail !== observedWrites) continue;
        const record = records.filter((item) => item.pending && item.tour.agentId === session.agentId)
          .sort((a, b) => String(a.tour.startedAt).localeCompare(String(b.tour.startedAt)))[0];
        if (!record) {
          await store.prune(session.agentId);
          if (writeTail !== observedWrites || getSession() !== session) continue;
          if (getSession() === session) onStatus("synced", session.agentId);
          return;
        }
        onStatus("pending", session.agentId);
        let result;
        try { result = await send(record.tour, session.credentials); }
        catch (error) { result = { ok: false, error }; }
        if (result.ok) await store.markSynced(record.id, record.revision);
        if (getSession() !== session) continue;
        if (result.authRejected) { onAuthRejected(session.agentId); return; }
        if (!result.ok) { onStatus("pending", session.agentId); return; }
      }
    })().catch((error) => {
      console.warn("Patrol synchronization failed:", error);
      const session = getSession();
      if (session) onStatus("pending", session.agentId);
    }).finally(() => { flushPromise = null; });
    return flushPromise;
  }

  return { enqueue, flush };
}
