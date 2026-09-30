type OrderedRoom = { id: string; categoryId: string | null; position: number };

/** Renumber only the destination group; moving out leaves harmless gaps in the source. */
export function roomDropUpdates(rooms: OrderedRoom[], roomId: string, categoryId: string | null, beforeId?: string) {
  const moved = rooms.find((room) => room.id === roomId);
  if (!moved || beforeId === roomId) return [];
  const destination = rooms.filter((room) => room.categoryId === categoryId && room.id !== roomId)
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const index = beforeId ? destination.findIndex((room) => room.id === beforeId) : destination.length;
  if (index < 0) return [];
  destination.splice(index, 0, moved);
  return destination.flatMap((room, position) => {
    const changedCategory = room.id === roomId && room.categoryId !== categoryId;
    if (!changedCategory && room.position === position) return [];
    return [{ id: room.id, position, ...(changedCategory ? { categoryId } : {}) }];
  });
}
