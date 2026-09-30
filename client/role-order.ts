type SortableRole = { id: string; position: number; isSystem: boolean };

export function roleDropUpdates(roles: SortableRole[], roleId: string, targetId: string, after: boolean, ceiling = Infinity) {
  const sorted = roles.filter((role) => !role.isSystem).sort((a, b) => b.position - a.position || a.id.localeCompare(b.id));
  const moved = sorted.find((role) => role.id === roleId);
  const target = sorted.find((role) => role.id === targetId);
  if (!moved || !target || moved === target || moved.position >= ceiling || target.position >= ceiling) return [];
  const positions = sorted.map((role) => role.position);
  // Tied positions cannot be faithfully reordered without changing hierarchy slots.
  if (new Set(positions).size !== positions.length) throw new Error("Roles have tied positions. Set distinct role positions before dragging.");
  const reordered = sorted.filter((role) => role !== moved);
  reordered.splice(reordered.indexOf(target) + Number(after), 0, moved);
  return reordered.flatMap((role, index) => role.position === positions[index] ? [] : [{ id: role.id, position: positions[index] }]);
}
