export const config = {
  brand: {
    name: 'Bicha',
    color: 0xf472b6,
    accentColor: 0xa855f7,
    tagline: 'Tu tienda de confianza para Robux y Discord Nitro.',
    logoUrl: '',
    bannerUrl: '',
    footer: 'Bicha Store • Compra fácil, atención privada'
  },
  discord: {
    defaultPrefix: '!',
    supportRoleId: '',
    ticketCategoryId: '',
    ordersLogChannelId: '',
    welcomeChannelId: ''
  },
  messages: {
    welcomeTitle: '💗 ¡Bienvenid@ a Bicha!',
    welcomeDescription: 'Hola {user}, llegaste a **{server}**. Ya somos **{memberCount}** miembros. Revisa nuestros paneles de Robux y Nitro para comenzar.'
  },
  payments: [
    { id: 'transfer', label: 'Transferencia', emoji: '🏦', description: 'El staff confirmará los datos de pago.' },
    { id: 'paypal', label: 'PayPal', emoji: '🅿️', description: 'El staff verificará la disponibilidad.' },
    { id: 'support', label: 'Hablar con soporte', emoji: '💬', description: 'Resuelve una duda antes de continuar.' }
  ],
  catalogs: {
    robux: {
      label: 'Robux', emoji: '💎', title: 'Bicha • Tienda de Robux',
      description: 'Elige el paquete ideal y abre tu pedido privado en segundos.',
      products: [
        { id: 'rbx-400', label: '400 Robux', price: '$4.99', emoji: '💎', description: 'Ideal para una compra rápida.' },
        { id: 'rbx-800', label: '800 Robux', price: '$8.99', emoji: '✨', description: 'Más Robux por un mejor precio.' },
        { id: 'rbx-1700', label: '1,700 Robux', price: '$17.99', emoji: '🔥', description: 'El paquete favorito de la comunidad.', featured: true },
        { id: 'rbx-4500', label: '4,500 Robux', price: '$44.99', emoji: '👑', description: 'Para llevar tu experiencia al máximo.' }
      ]
    },
    nitro: {
      label: 'Discord Nitro', emoji: '🚀', title: 'Bicha • Discord Nitro',
      description: 'Mejora tu perfil, transmite en alta calidad y disfruta más beneficios.',
      products: [
        { id: 'nitro-basic-1m', label: 'Nitro Basic • 1 mes', price: '$2.99', emoji: '💜', description: 'Emojis personalizados y cargas más grandes.' },
        { id: 'nitro-1m', label: 'Nitro • 1 mes', price: '$9.99', emoji: '🚀', description: 'La experiencia completa de Discord Nitro.', featured: true },
        { id: 'nitro-1y', label: 'Nitro • 1 año', price: '$99.99', emoji: '👑', description: 'Nitro completo durante 12 meses.' }
      ]
    }
  }
};

export const catalogById = (id) => config.catalogs[id] || null;
export const productById = (catalogId, productId) => catalogById(catalogId)?.products.find((product) => product.id === productId) || null;
export const paymentById = (id) => config.payments.find((payment) => payment.id === id) || null;
