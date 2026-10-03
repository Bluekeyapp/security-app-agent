const DB_NAME = "security-patrol-agent";

export function createTourStore(indexedDB = globalThis.indexedDB) {
  let databasePromise;

  function openDatabase() {
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        if (!indexedDB) return reject(new Error("IndexedDB unavailable"));
        const request = indexedDB.open(DB_NAME, 2);
        request.onupgradeneeded = () => {
          for (const name of ["tours", "photos"]) {
            if (!request.result.objectStoreNames.contains(name)) {
              request.result.createObjectStore(name, { keyPath: "id" });
            }
          }
        };
        request.onsuccess = () => {
          const database = request.result;
          database.onversionchange = () => { database.close(); databasePromise = null; };
          resolve(database);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("IndexedDB blocked"));
      }).catch((error) => { databasePromise = null; throw error; });
    }
    return databasePromise;
  }

  async function transact(mode, operation) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(["tours", "photos"], mode);
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("Local save aborted"));
      try {
        operation(transaction.objectStore("tours"), transaction.objectStore("photos"), (value) => { result = value; });
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    });
  }

  return {
    async put(tour) {
      if (!tour?.id || !tour.agentId) throw new Error("Patrol owner required");
      const revision = crypto.randomUUID();
      const snapshot = structuredClone(tour);
      await transact("readwrite", (tours, photos) => {
        snapshot.incidents = (snapshot.incidents || []).map((incident) => {
          const { photoData, ...rest } = incident;
          if (!photoData) return rest;
          const photoId = `${tour.id}:${incident.id}`;
          photos.put({ id: photoId, data: photoData });
          return { ...rest, photoId };
        });
        tours.put({ id: snapshot.id, tour: snapshot, revision, pending: true });
      });
      return revision;
    },
    async all() {
      const records = await transact("readonly", (tours, photos, finish) => {
        let savedTours, savedPhotos;
        function complete() {
          if (!savedTours || !savedPhotos) return;
          const images = new Map(savedPhotos.map((photo) => [photo.id, photo.data]));
          finish(savedTours.map((record) => ({ ...record, tour: {
            ...record.tour,
            incidents: (record.tour.incidents || []).map(({ photoId, ...incident }) => ({
              ...incident,
              photoData: photoId ? images.get(photoId) || "" : incident.photoData || ""
            }))
          } })));
        }
        const toursRequest = tours.getAll();
        toursRequest.onsuccess = () => { savedTours = toursRequest.result; complete(); };
        const photosRequest = photos.getAll();
        photosRequest.onsuccess = () => { savedPhotos = photosRequest.result; complete(); };
      });
      return records;
    },
    async markSynced(id, revision) {
      await transact("readwrite", (tours) => {
        const request = tours.get(id);
        request.onsuccess = () => {
          if (request.result?.revision === revision) tours.put({ ...request.result, pending: false });
        };
      });
    },
    async prune(agentId) {
      await transact("readwrite", (tours, photos) => {
        const request = tours.getAll();
        request.onsuccess = () => {
          const finished = request.result.filter((record) => !record.pending && record.tour.agentId === agentId && record.tour.status !== "active")
            .sort((a, b) => String(b.tour.completedAt || b.tour.cancelledAt || b.tour.startedAt).localeCompare(String(a.tour.completedAt || a.tour.cancelledAt || a.tour.startedAt)));
          for (const record of finished.slice(25)) {
            tours.delete(record.id);
            for (const incident of record.tour.incidents || []) if (incident.photoId) photos.delete(incident.photoId);
          }
        };
      });
    }
  };
}

export const tourStore = createTourStore();

export async function migrateLegacyTours(store, tours, cleanup) {
  const existing = new Set((await store.all()).map((record) => record.id));
  for (const tour of tours.filter((tour) => tour?.id && tour.agentId)) {
    if (!existing.has(tour.id)) {
      await store.put(tour);
      existing.add(tour.id);
    }
  }
  // Keep the old copy until every record has been committed successfully.
  cleanup();
}
