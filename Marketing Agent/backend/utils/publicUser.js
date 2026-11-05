// The user fields that are safe to send to the browser (never the password hash)
module.exports = (u) => {
  const o = u.toObject ? u.toObject() : u;
  return {
    id: o._id,
    name: o.name,
    email: o.email,
    role: o.role,
    phone: o.phone || "",
    preferences: o.preferences || {},
  };
};
