import 'dotenv/config';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, Client,
  EmbedBuilder, Events, GatewayIntentBits, MessageFlags, ModalBuilder, PermissionFlagsBits,
  RoleSelectMenuBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle
} from 'discord.js';
import { catalogById, config, paymentById, productById } from './config.js';
import { findOrderByChannel, getGuildSettings, getPrefix, openOrders, saveOrder, setGuildSettings, setPrefix, updateOrder } from './database.js';
import * as music from './music.js';
import { getPayment, savePayment, aliasOwner } from './payments.js';

const token = process.env.DISCORD_TOKEN?.trim();
if (!token || /pega|ejemplo|example|your.?token/i.test(token)) throw new Error('Completa DISCORD_TOKEN con el token real de Bicha en D:\\botbri\\.env.');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates] });
const ephemeral = MessageFlags.Ephemeral;

function decorate(embed, { banner = false } = {}) {
  embed.setColor(config.brand.color).setFooter({ text: config.brand.footer });
  if (config.brand.logoUrl) embed.setThumbnail(config.brand.logoUrl);
  if (banner && config.brand.bannerUrl) embed.setImage(config.brand.bannerUrl);
  return embed;
}

function isStaff(source) {
  const guildId = source.guildId || source.guild?.id;
  const settings = getGuildSettings(guildId, { supportRoleId: config.discord.supportRoleId });
  return source.memberPermissions?.has?.(PermissionFlagsBits.ManageChannels)
    || source.member?.permissions?.has?.(PermissionFlagsBits.ManageChannels)
    || Boolean(settings.supportRoleId && source.member?.roles?.cache?.has(settings.supportRoleId));
}
function isAdmin(source) { return Boolean(source.memberPermissions?.has?.(PermissionFlagsBits.Administrator) || source.member?.permissions?.has?.(PermissionFlagsBits.Administrator)); }

function mainPanel() {
  const embed = decorate(new EmbedBuilder()
    .setTitle('💗 Bicha Store')
    .setDescription(`${config.brand.tagline}\n\n**¿Qué quieres comprar hoy?**\n\n💎 **Robux** — paquetes para todos los presupuestos.\n🚀 **Discord Nitro** — mejora tu perfil y tus llamadas.\n\n> Compra mediante un ticket privado con nuestro equipo.`), { banner: true });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('catalog:open:robux').setLabel('Comprar Robux').setEmoji('💎').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('catalog:open:nitro').setLabel('Comprar Nitro').setEmoji('🚀').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('help:home').setLabel('Ayuda').setEmoji('❔').setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [row] };
}

function ticketSetupInterface(guildId) {
  const settings = getGuildSettings(guildId, { ticketCategoryId: config.discord.ticketCategoryId, supportRoleId: config.discord.supportRoleId });
  const embed = decorate(new EmbedBuilder().setTitle('⚙️ Configurar tickets de Bicha').setDescription(`Configura dónde se crearán los tickets y quién podrá verlos.\n\n**Categoría:** ${settings.ticketCategoryId ? `<#${settings.ticketCategoryId}>` : 'Sin configurar'}\n**Rol de soporte:** ${settings.supportRoleId ? `<@&${settings.supportRoleId}>` : 'Solo administradores'}\n\nCuando termines, pulsa **Publicar panel**.`));
  const category = new ChannelSelectMenuBuilder().setCustomId('ticket:setup:category').setPlaceholder('📁 Selecciona la categoría de tickets').setChannelTypes(ChannelType.GuildCategory).setMinValues(1).setMaxValues(1);
  const role = new RoleSelectMenuBuilder().setCustomId('ticket:setup:role').setPlaceholder('🛡️ Selecciona el rol de soporte').setMinValues(1).setMaxValues(1);
  const publish = new ButtonBuilder().setCustomId('ticket:setup:publish').setLabel('Publicar panel').setEmoji('📨').setStyle(ButtonStyle.Success).setDisabled(!settings.ticketCategoryId);
  const edit = new ButtonBuilder().setCustomId('ticket:setup:edit').setLabel('Editar embed').setEmoji('✏️').setStyle(ButtonStyle.Primary);
  const preview = new ButtonBuilder().setCustomId('ticket:setup:preview').setLabel('Vista previa').setEmoji('👁️').setStyle(ButtonStyle.Secondary);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(category), new ActionRowBuilder().addComponents(role), new ActionRowBuilder().addComponents(edit, preview, publish)] };
}

function ticketPublicPanel(guildId, preview = false) {
  const settings = getGuildSettings(guildId);
  const embed = new EmbedBuilder().setTitle(settings.ticketTitle || '🎫 Tickets • Bicha').setDescription(settings.ticketDescription || 'Abre un ticket privado para comprar Robux o Nitro o solicitar soporte.').setColor(settings.ticketColor ? parseInt(settings.ticketColor, 16) : config.brand.color);
  if (settings.ticketImage) embed.setImage(settings.ticketImage);
  if (settings.ticketThumbnail) embed.setThumbnail(settings.ticketThumbnail);
  const button = new ButtonBuilder().setCustomId('ticket:open').setLabel('Abrir ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary).setDisabled(preview);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(button)] };
}

function ticketProductPanel() {
  const embed = decorate(new EmbedBuilder().setTitle('🛒 Bicha').setDescription('Selecciona un producto para comenzar.'));
  const menu = new StringSelectMenuBuilder().setCustomId('ticket:product').setPlaceholder('🛒 Selecciona un producto').addOptions(
    { label: 'Robux', value: 'robux', emoji: '💎', description: 'Abrir un pedido de Robux' },
    { label: 'Nitro', value: 'nitro', emoji: '✨', description: 'Abrir un pedido de Discord Nitro' }
  );
  const close = new ButtonBuilder().setCustomId('ticket:close').setLabel('Cerrar ticket').setStyle(ButtonStyle.Danger);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(close)] };
}

const ticketLocks = new Set();
function ticketInfo(channel) {
  const topic = channel?.topic || '';
  const owner = topic.match(/(?:^|;)supportOwner=(\d+)(?:;|$)/)?.[1] || topic.match(/(?:^|;)owner=(\d+)(?:;|$)/)?.[1];
  const status = topic.match(/(?:^|;)status=([^;]+)/)?.[1];
  return owner && status ? { owner, status, topic } : null;
}
function ticketStatusTopic(topic, status) { return topic.replace(/(^|;)status=[^;]+/, `$1status=${status}`); }
function closedTicketControls() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:reopen').setLabel('Reabrir').setEmoji('🔓').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticket:delete').setLabel('Borrar ticket').setEmoji('⛔').setStyle(ButtonStyle.Danger)
  );
}
async function openTicket(interaction) {
  const settings = getGuildSettings(interaction.guildId, { ticketCategoryId: config.discord.ticketCategoryId, supportRoleId: config.discord.supportRoleId });
  const category = settings.ticketCategoryId && await interaction.guild.channels.fetch(settings.ticketCategoryId).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) throw new Error('El staff debe configurar una categoría válida con /ticket setup.');
  const previous = interaction.guild.channels.cache.find((channel) => channel.type === ChannelType.GuildText && (channel.topic?.includes(`owner=${interaction.user.id};`) || channel.topic?.includes(`supportOwner=${interaction.user.id};`)) && !channel.topic?.includes('status=closed'));
  if (previous) return { channel: previous, existing: true };
  const overwrites = [
    { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] }
  ];
  if (settings.supportRoleId) overwrites.push({ id: settings.supportRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  const name = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'cliente';
  const channel = await interaction.guild.channels.create({ name: `ticket-${name}-${interaction.user.id.slice(-4)}`, type: ChannelType.GuildText, parent: category.id, topic: `supportOwner=${interaction.user.id};status=open`, permissionOverwrites: overwrites });
  await channel.send(ticketProductPanel());
  return { channel, existing: false };
}

function ticketPaymentPanel(catalogId) {
  const catalog = catalogById(catalogId);
  const embed = decorate(new EmbedBuilder().setTitle('💳 Selecciona un método de pago').setDescription(`**Producto:** ${catalog.label}`));
  const menu = new StringSelectMenuBuilder().setCustomId(`ticket:payment:${catalogId}`).setPlaceholder('💳 Selecciona un método de pago').addOptions(config.payments.map((payment) => ({ label: payment.label, value: payment.id, description: payment.description, emoji: payment.emoji })));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
}

function catalogPanel(catalogId) {
  const catalog = catalogById(catalogId);
  const products = catalog.products.map((product) => `${product.emoji} **${product.label}** · **${product.price}**${product.featured ? ' · ⭐ Popular' : ''}\n> ${product.description}`).join('\n\n');
  const embed = decorate(new EmbedBuilder().setTitle(`${catalog.emoji} ${catalog.title}`).setDescription(`${catalog.description}\n\n${products}\n\n**Selecciona tu paquete abajo para continuar.**`), { banner: true });
  const menu = new StringSelectMenuBuilder().setCustomId(`catalog:product:${catalogId}`).setPlaceholder(`${catalog.emoji} Selecciona un paquete`).addOptions(catalog.products.slice(0, 25).map((product) => ({ label: `${product.label} — ${product.price}`.slice(0, 100), value: product.id, description: product.description.slice(0, 100), emoji: product.emoji })));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
}

function checkoutPanel(catalogId, product) {
  const catalog = catalogById(catalogId);
  const embed = decorate(new EmbedBuilder().setTitle(`${product.emoji} ${product.label}`).setDescription(`**Categoría:** ${catalog.label}\n**Precio:** ${product.price}\n\n${product.description}\n\nSelecciona el método de pago para abrir tu pedido.`));
  const menu = new StringSelectMenuBuilder().setCustomId(`catalog:payment:${catalogId}:${product.id}`).setPlaceholder('💳 Selecciona un método de pago').addOptions(config.payments.map((payment) => ({ label: payment.label, value: payment.id, description: payment.description.slice(0, 100), emoji: payment.emoji })));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
}

function orderId() { return `BICHA-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`; }
function statusText(status) { return ({ pending: '🟡 Esperando atención', paid: '🟣 Pago confirmado', processing: '🔵 Preparando entrega', delivered: '🟢 Entregado', closed: '⚫ Cerrado' })[status] || status; }
function orderEmbed(order) {
  return decorate(new EmbedBuilder().setTitle(`${order.catalogEmoji} Pedido ${order.id}`).setDescription(`**Estado:** ${statusText(order.status)}`).addFields(
    { name: 'Cliente', value: `<@${order.userId}>`, inline: true },
    { name: 'Producto', value: `${order.productLabel}\n${order.price}`, inline: true },
    { name: 'Pago', value: order.paymentLabel, inline: true },
    { name: order.catalogId === 'robux' ? 'Usuario de Roblox' : 'Entrega', value: order.deliveryDetail, inline: false }
  ).setTimestamp(new Date(order.createdAt)));
}

function orderButtons(status) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('order:paid').setLabel('Pago confirmado').setEmoji('💳').setStyle(ButtonStyle.Primary).setDisabled(status !== 'pending'),
    new ButtonBuilder().setCustomId('order:processing').setLabel('Preparando').setEmoji('📦').setStyle(ButtonStyle.Secondary).setDisabled(!['paid', 'pending'].includes(status)),
    new ButtonBuilder().setCustomId('order:delivered').setLabel('Entregado').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(status === 'delivered' || status === 'closed'),
    new ButtonBuilder().setCustomId('order:close').setLabel('Cerrar').setEmoji('🔒').setStyle(ButtonStyle.Danger).setDisabled(status === 'closed')
  );
}

async function sendLog(guild, content, embed) {
  if (!config.discord.ordersLogChannelId) return;
  const channel = await guild.channels.fetch(config.discord.ordersLogChannelId).catch(() => null);
  if (channel?.isTextBased()) await channel.send({ content, embeds: embed ? [embed] : [], allowedMentions: { parse: [] } }).catch(() => {});
}

async function createTicket(interaction, catalogId, product, payment, deliveryDetail) {
  const previous = interaction.guild.channels.cache.find((channel) => channel.type === ChannelType.GuildText && channel.topic?.includes(`owner=${interaction.user.id}`) && channel.topic?.includes(`catalog=${catalogId}`) && !channel.topic?.includes('status=closed'));
  if (previous) return { existing: true, channel: previous };
  const id = orderId();
  const settings = getGuildSettings(interaction.guildId, { ticketCategoryId: config.discord.ticketCategoryId, supportRoleId: config.discord.supportRoleId });
  if (!settings.ticketCategoryId) throw new Error('El staff todavía no configuró la categoría con /ticket setup.');
  const category = await interaction.guild.channels.fetch(settings.ticketCategoryId).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) throw new Error('La categoría configurada ya no existe. El staff debe usar /ticket setup otra vez.');
  const permissions = [
    { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] }
  ];
  if (settings.supportRoleId) permissions.push({ id: settings.supportRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  const cleanName = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'cliente';
  const existingTicket = interaction.channel?.type === ChannelType.GuildText && interaction.channel.topic === `supportOwner=${interaction.user.id};status=open` ? interaction.channel : null;
  const channel = existingTicket || await interaction.guild.channels.create({ name: `${catalogId}-${cleanName}-${id.slice(-3).toLowerCase()}`, type: ChannelType.GuildText, parent: settings.ticketCategoryId, topic: `order=${id};owner=${interaction.user.id};catalog=${catalogId};status=pending`, permissionOverwrites: permissions, reason: `Pedido ${id} de ${config.brand.name}` });
  if (existingTicket) await channel.setTopic(`order=${id};owner=${interaction.user.id};catalog=${catalogId};status=pending`);
  const catalog = catalogById(catalogId);
  const order = saveOrder({ id, guildId: interaction.guildId, channelId: channel.id, userId: interaction.user.id, catalogId, catalogEmoji: catalog.emoji, productId: product.id, productLabel: product.label, price: product.price, paymentId: payment.id, paymentLabel: payment.label, deliveryDetail, status: 'pending', createdAt: new Date().toISOString() });
  await channel.send({ content: `<@${interaction.user.id}>${settings.supportRoleId ? ` · <@&${settings.supportRoleId}>` : ''}`, embeds: [orderEmbed(order)], components: [orderButtons(order.status)], allowedMentions: { users: [interaction.user.id], roles: settings.supportRoleId ? [settings.supportRoleId] : [] } });
  await sendLog(interaction.guild, `📥 Nuevo pedido **${id}** en ${channel}`, orderEmbed(order));
  return { existing: false, channel, order };
}

function helpPanel(staff, section = 'home', prefix = config.discord.defaultPrefix) {
  let embed;
  if (section === 'info') embed = new EmbedBuilder().setTitle('🔎  Información y perfiles').setDescription('Consulta datos e imágenes de usuarios y servidores.').addFields(
    { name: '👥 Usuarios', value: `\`${prefix}user\` · Tu perfil\n\`${prefix}user info @usuario\` · Perfil de otra persona\n\`${prefix}avatar @usuario\` · Avatar\n\`${prefix}banner @usuario\` · Banner`, inline: false },
    { name: '🏠 Servidor', value: `\`${prefix}server\` · Información\n\`${prefix}serveravatar\` · Icono\n\`${prefix}serverbanner\` · Banner`, inline: false }
  );
  else if (section === 'shop') embed = new EmbedBuilder().setTitle('🛍️  Comprar en Bicha').setDescription('Tu pedido, en unos pasos.\n\n**01**  Pulsa **Abrir ticket** en el panel de la tienda.\n**02**  Dentro del canal, selecciona **Robux** o **Nitro**.\n**03**  Elige un método de pago o solicita soporte.\n**04**  Nuestro equipo continuará contigo en el ticket.').addFields({ name: '🎫 ¿Terminaste?', value: `Usa el botón **Cerrar ticket** o escribe \`${prefix}close\` dentro del canal.` });
  else if (section === 'music') embed = new EmbedBuilder().setTitle('🎶  Música & voz').setDescription('Tu música, directamente en el canal de voz.\nÚnete a un canal y elige un comando:').addFields(
    { name: '▶️  Reproducir', value: `\`${prefix}play <enlace>\`\nAñade un enlace de YouTube.`, inline: true },
    { name: '📋  Cola', value: `\`${prefix}queue\`\nConsulta la canción actual.`, inline: true },
    { name: '⏭️  Controles', value: `\`${prefix}skip\` · \`${prefix}stop\`\nSalta o detiene la música.`, inline: true },
    { name: '🔊  Canal de voz', value: `Usa \`${prefix}vc\` para conectar a Bicha y \`${prefix}leave\` para desconectarla.` }
  );
  else if (section === 'staff' && staff) embed = new EmbedBuilder().setTitle('🛠️  Centro de administración').setDescription('Herramientas para gestionar Bicha y tu tienda.').addFields(
    { name: '🎫  Tickets', value: `\`/ticket setup\` · Configurar panel\n\`${prefix}close\` · Cerrar ticket\n\`${prefix}delete\` · Borrar ticket cerrado`, inline: false },
    { name: '💳  Pagos', value: `\`${prefix}tarjeta\` · Tu tarjeta\n\`${prefix}paypal\` · Tu PayPal`, inline: true },
    { name: '🧹  Moderación', value: `\`${prefix}purge 100\` · Mensajes\n\`${prefix}purge bots 100\` · Bots`, inline: true },
    { name: '⚙️  Personalización', value: `\`${prefix}embed edit\` · Editar panel\n\`/prefijo\` · Cambiar prefijo\n\`${prefix}vc\` · Conectar a voz` }
  );
  else embed = new EmbedBuilder().setTitle('💗  Bicha · Centro de ayuda').setDescription(`¡Bienvenid@! Estamos aquí para ayudarte con tu compra y acompañarte con música.\n\n**¿Qué necesitas hoy?**\n🛍️  Descubre cómo comprar Robux o Nitro.\n🎶  Controla la música del servidor.\n${staff ? '🛠️  Gestiona la tienda desde el panel privado.\n' : ''}\n**Prefijo del servidor**  \`${prefix}\`\nTambién puedes usar \`/help\`.`);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('help:home').setLabel('Inicio').setEmoji('🏠').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('help:shop').setLabel('Comprar').setEmoji('🛍️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('help:music').setLabel('Música').setEmoji('🎶').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('help:info').setLabel('Info').setEmoji('🔎').setStyle(ButtonStyle.Secondary)
  );
  if (staff) row.addComponents(new ButtonBuilder().setCustomId('help:staff').setLabel('Staff').setEmoji('🛠️').setStyle(ButtonStyle.Success));
  return { embeds: [decorate(embed, { banner: section === 'home' })], components: [row] };
}

function replaceWelcome(text, member) { return text.replaceAll('{user}', `<@${member.id}>`).replaceAll('{server}', member.guild.name).replaceAll('{memberCount}', String(member.guild.memberCount)); }

function imageLinkRow(entries) {
  const links = entries.filter((entry) => entry.url).map((entry) => new ButtonBuilder().setLabel(entry.label).setEmoji('🖼️').setStyle(ButtonStyle.Link).setURL(entry.url));
  return links.length ? [new ActionRowBuilder().addComponents(links)] : [];
}

function serverInfo(guild) {
  const icon = guild.iconURL({ size: 1024 }); const banner = guild.bannerURL({ size: 2048 });
  const verification = ['Ninguna', 'Baja', 'Media', 'Alta', 'Muy alta'][guild.verificationLevel] || 'Desconocida';
  const embed = new EmbedBuilder().setColor(config.brand.color).setTitle(`✦ ${guild.name}`).setDescription([
    `🪪 **ID:** \`${guild.id}\``, `👑 **Dueño/a:** <@${guild.ownerId}>`, `📆 **Creado:** <t:${Math.floor(guild.createdTimestamp / 1000)}:F>`,
    `👥 **Miembros:** ${guild.memberCount}`, `💬 **Canales:** ${guild.channels.cache.size}`, `⚔️ **Roles:** ${guild.roles.cache.size}`, `🎭 **Emojis:** ${guild.emojis.cache.size}`,
    `🚀 **Mejoras:** ${guild.premiumSubscriptionCount ?? 0}`, `🔒 **Verificación:** ${verification}`
  ].join('\n')).setFooter({ text: `Bicha • Nivel ${guild.premiumTier}` }).setTimestamp();
  if (icon) embed.setThumbnail(icon);
  const links = [{ label: 'Icono', url: icon }, { label: 'Banner', url: banner }];
  if (guild.features.includes('DISCOVERABLE')) links.push({ label: 'Descubrimiento', url: `https://discord.com/servers/${guild.id}` });
  return { embeds: [embed], components: imageLinkRow(links), allowedMentions: { parse: [] } };
}

async function resolvePerson(message, args) {
  const input = args[0];
  if (!input) return { user: message.author, member: message.member };
  const id = input.match(/^<@!?(\d+)>$/)?.[1] || (/^\d{17,20}$/.test(input) ? input : null);
  if (!id) return null;
  const member = await message.guild.members.fetch(id).catch(() => null);
  const user = member?.user || await message.client.users.fetch(id).catch(() => null);
  return user ? { user, member } : null;
}

function userInfo(user, member) {
  const roles = member?.roles.cache.filter((role) => role.id !== member.guild.id).sort((a, b) => b.position - a.position).map((role) => `<@&${role.id}>`) || [];
  const embed = new EmbedBuilder().setColor(member?.displayColor || config.brand.color).setTitle('👤  Información de usuario').setThumbnail(user.displayAvatarURL({ size: 512 })).setDescription(`**${user.globalName || user.username}**\n@${user.username}${user.bot ? ' · 🤖 Bot' : ''}`).addFields(
    { name: '🪪 ID', value: `\`${user.id}\``, inline: true },
    { name: '📆 Cuenta creada', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:D>`, inline: true },
    { name: '📥 Entró al servidor', value: member?.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:D>` : 'No disponible', inline: true },
    { name: `🎭 Roles (${roles.length})`, value: roles.length ? roles.slice(0, 15).join(' ').slice(0, 1024) : 'Sin roles adicionales' }
  ).setFooter({ text: 'Bicha • Perfil de usuario' }).setTimestamp();
  return { embeds: [embed], components: imageLinkRow([{ label: 'Avatar', url: user.displayAvatarURL({ size: 1024 }) }]), allowedMentions: { parse: [] } };
}

function imagePanel(title, url, description) {
  if (!url) return { content: description, allowedMentions: { parse: [] } };
  return { embeds: [new EmbedBuilder().setColor(config.brand.color).setTitle(title).setImage(url).setFooter({ text: 'Bicha • Imágenes' })], components: imageLinkRow([{ label: 'Abrir imagen', url }]), allowedMentions: { parse: [] } };
}

client.once(Events.ClientReady, (ready) => {
  console.log(`✓ ${config.brand.name} conectada como ${ready.user.tag}`);
});

client.on(Events.GuildMemberAdd, async (member) => {
  if (!config.discord.welcomeChannelId) return;
  const channel = await member.guild.channels.fetch(config.discord.welcomeChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const embed = decorate(new EmbedBuilder().setTitle(replaceWelcome(config.messages.welcomeTitle, member)).setDescription(replaceWelcome(config.messages.welcomeDescription, member)).setThumbnail(member.user.displayAvatarURL({ size: 256 })));
  await channel.send({ content: `<@${member.id}>`, embeds: [embed], allowedMentions: { users: [member.id] } }).catch(() => {});
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'help') { const prefix = getPrefix(interaction.guildId, config.discord.defaultPrefix); return interaction.reply({ ...helpPanel(isAdmin(interaction), 'home', prefix), flags: ephemeral }); }
      if (interaction.commandName === 'panel') {
        const type = interaction.options.getString('tipo');
        const payload = type === 'principal' ? mainPanel() : catalogPanel(type);
        await interaction.channel.send(payload);
        return interaction.reply({ content: `✅ Panel **${type}** publicado.`, flags: ephemeral });
      }
      if (interaction.commandName === 'pedidos') {
        const orders = openOrders(interaction.guildId);
        const text = orders.length ? orders.slice(0, 25).map((order) => `• <#${order.channelId}> · ${order.productLabel} · ${statusText(order.status)}`).join('\n') : 'No hay pedidos abiertos.';
        return interaction.reply({ embeds: [decorate(new EmbedBuilder().setTitle('📋 Pedidos abiertos').setDescription(text))], flags: ephemeral });
      }
      if (interaction.commandName === 'prefijo') {
        const prefix = interaction.options.getString('nuevo').trim();
        if (!/^\S{1,5}$/.test(prefix)) return interaction.reply({ content: 'Usa entre 1 y 5 caracteres sin espacios.', flags: ephemeral });
        setPrefix(interaction.guildId, prefix);
        return interaction.reply({ content: `✅ El prefijo de Bicha ahora es \`${prefix}\`.`, flags: ephemeral });
      }
      if (interaction.commandName === 'ticket' && interaction.options.getSubcommand() === 'setup') {
        return interaction.reply({ ...ticketSetupInterface(interaction.guildId), flags: ephemeral });
      }
      if (interaction.commandName === 'musica') {
        const action = interaction.options.getSubcommand();
        if (action === 'salir') { if (!isStaff(interaction)) return interaction.reply({ content: 'Solo el staff puede desconectarme.', flags: ephemeral }); music.disconnect(interaction.guildId); return interaction.reply('👋 Bicha salió del canal de voz.'); }
        const voice = interaction.member.voice.channel;
        if (!voice) return interaction.reply({ content: 'Únete primero a un canal de voz.', flags: ephemeral });
        if (action === 'play') { await interaction.deferReply(); const track = await music.enqueue(interaction.guild, voice, interaction.options.getString('url'), interaction.user.username); return interaction.editReply(`🎶 Añadido: **${track.title}**`); }
        if (action === 'cola') { const state = music.status(interaction.guildId); const text = state?.current ? `**Sonando:** ${state.current.title}\n\n${state.queue.length ? state.queue.slice(0, 10).map((track, index) => `${index + 1}. ${track.title}`).join('\n') : 'No hay más canciones.'}` : 'La cola está vacía.'; return interaction.reply({ embeds: [decorate(new EmbedBuilder().setTitle('🎶 Cola de Bicha').setDescription(text))], flags: ephemeral }); }
        if (action === 'skip') return interaction.reply(music.skip(interaction.guildId) ? '⏭️ Canción saltada.' : 'No hay música sonando.');
        if (action === 'stop') { music.stop(interaction.guildId); return interaction.reply('⏹️ Música detenida. Bicha permanece en voz.'); }
      }
    }

    if ((interaction.customId?.startsWith('ticket:setup:') || interaction.customId?.startsWith('embed:edit:') || interaction.customId?.startsWith('embed:save:')) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: 'Solo administradores pueden configurar tickets.', flags: ephemeral });
    if (interaction.isChannelSelectMenu() && interaction.customId === 'ticket:setup:category') { setGuildSettings(interaction.guildId, { ticketCategoryId: interaction.values[0] }); return interaction.update(ticketSetupInterface(interaction.guildId)); }
    if (interaction.isRoleSelectMenu() && interaction.customId === 'ticket:setup:role') { setGuildSettings(interaction.guildId, { supportRoleId: interaction.values[0] }); return interaction.update(ticketSetupInterface(interaction.guildId)); }
    if (interaction.isButton() && (interaction.customId === 'ticket:setup:edit' || interaction.customId.startsWith('embed:edit:'))) {
      const settings = getGuildSettings(interaction.guildId);
      const targetId = interaction.customId.startsWith('embed:edit:') ? interaction.customId.split(':')[2] : '';
      const input = (id, label, value, style, required, max) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max).setValue(value || ''));
      const modal = new ModalBuilder().setCustomId(targetId ? `embed:save:${targetId}` : 'ticket:setup:save').setTitle('Editar panel de tickets').addComponents(
        input('title', 'Título', settings.ticketTitle || '🎫 Tickets • Bicha', TextInputStyle.Short, true, 256),
        input('description', 'Descripción', settings.ticketDescription || 'Abre un ticket privado para comprar Robux o Nitro o solicitar soporte.', TextInputStyle.Paragraph, true, 2000),
        input('color', 'Color hexadecimal (ejemplo: F472B6)', settings.ticketColor || config.brand.color.toString(16).padStart(6, '0'), TextInputStyle.Short, true, 7),
        input('image', 'URL de imagen grande (opcional)', settings.ticketImage, TextInputStyle.Short, false, 1000),
        input('thumbnail', 'URL del logo pequeño (opcional)', settings.ticketThumbnail, TextInputStyle.Short, false, 1000)
      );
      return interaction.showModal(modal);
    }
    if (interaction.isModalSubmit() && (interaction.customId === 'ticket:setup:save' || interaction.customId.startsWith('embed:save:'))) {
      const title = interaction.fields.getTextInputValue('title').trim(); const description = interaction.fields.getTextInputValue('description').trim();
      const color = interaction.fields.getTextInputValue('color').trim().replace(/^#/, '');
      const image = interaction.fields.getTextInputValue('image').trim(); const thumbnail = interaction.fields.getTextInputValue('thumbnail').trim();
      const validUrl = (value) => { if (!value) return true; try { return ['https:', 'http:'].includes(new URL(value).protocol); } catch { return false; } };
      if (!title || !description || !/^[0-9a-fA-F]{6}$/.test(color) || !validUrl(image) || !validUrl(thumbnail)) return interaction.reply({ content: 'Revisa el título, la descripción, el color hexadecimal de 6 dígitos y los enlaces http/https de las imágenes.', flags: ephemeral });
      setGuildSettings(interaction.guildId, { ticketTitle: title, ticketDescription: description, ticketColor: color, ticketImage: image, ticketThumbnail: thumbnail });
      if (interaction.customId.startsWith('embed:save:')) {
        const targetId = interaction.customId.split(':')[2];
        const target = await interaction.channel.messages.fetch(targetId).catch(() => null);
        if (!target || target.author.id !== client.user.id || !target.components.some((row) => row.components.some((component) => component.customId === 'ticket:open'))) return interaction.reply({ content: 'Diseño guardado, pero no encontré ese panel. Usa !embed edit en el canal del panel.', flags: ephemeral });
        await target.edit(ticketPublicPanel(interaction.guildId));
        return interaction.reply({ content: '✅ Panel actualizado en el mismo mensaje.', flags: ephemeral });
      }
      return interaction.reply({ content: '✅ Diseño guardado. Abre **Vista previa** y publica el panel cuando quieras.', flags: ephemeral });
    }
    if (interaction.isButton() && interaction.customId === 'ticket:setup:preview') return interaction.reply({ ...ticketPublicPanel(interaction.guildId, true), flags: ephemeral });
    if (interaction.isButton() && interaction.customId === 'ticket:setup:publish') {
      const settings = getGuildSettings(interaction.guildId, { ticketCategoryId: config.discord.ticketCategoryId });
      if (!settings.ticketCategoryId) return interaction.reply({ content: 'Selecciona primero una categoría.', flags: ephemeral });
      await interaction.channel.send(ticketPublicPanel(interaction.guildId));
      return interaction.reply({ content: `✅ Panel publicado. Los tickets se crearán en <#${settings.ticketCategoryId}>.`, flags: ephemeral });
    }
    if (interaction.isButton() && interaction.customId === 'ticket:open') {
      const key = `${interaction.guildId}:${interaction.user.id}`;
      if (ticketLocks.has(key)) return interaction.reply({ content: 'Tu ticket se está creando, espera un momento.', flags: ephemeral });
      ticketLocks.add(key);
      try { await interaction.deferReply({ flags: ephemeral }); const result = await openTicket(interaction); return await interaction.editReply(result.existing ? `Ya tienes un ticket abierto: ${result.channel}` : `🎫 Tu ticket está listo: ${result.channel}`); } finally { ticketLocks.delete(key); }
    }
    if (interaction.isButton() && ['ticket:close', 'order:close'].includes(interaction.customId)) {
      const ticket = ticketInfo(interaction.channel);
      if (!ticket || ticket.status === 'closed') return interaction.reply({ content: 'Este ticket ya no está abierto.', flags: ephemeral });
      if (ticket.owner !== interaction.user.id && !isStaff(interaction)) return interaction.reply({ content: 'Solo el cliente o el staff puede cerrar el ticket.', flags: ephemeral });
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket:confirm-close').setLabel('Cerrar').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId('ticket:cancel').setLabel('Cancelar').setStyle(ButtonStyle.Secondary));
      return interaction.reply({ content: '¿Seguro que quieres cerrar este ticket?', components: [row], flags: ephemeral });
    }
    if (interaction.isButton() && interaction.customId === 'ticket:cancel') return interaction.update({ content: 'Acción cancelada.', components: [] });
    if (interaction.isButton() && interaction.customId === 'ticket:confirm-close') {
      const ticket = ticketInfo(interaction.channel);
      if (!ticket || ticket.status === 'closed') return interaction.update({ content: 'Este ticket ya está cerrado.', components: [] });
      if (ticket.owner !== interaction.user.id && !isStaff(interaction)) return interaction.reply({ content: 'Solo el cliente o el staff puede cerrar el ticket.', flags: ephemeral });
      await interaction.deferUpdate();
      await interaction.channel.permissionOverwrites.edit(ticket.owner, { ViewChannel: false, SendMessages: false });
      await interaction.channel.setTopic(ticketStatusTopic(ticket.topic, 'closed'));
      const order = findOrderByChannel(interaction.channelId); if (order) updateOrder(order.id, { status: 'closed' });
      await interaction.channel.send({ embeds: [decorate(new EmbedBuilder().setTitle('🔒 Ticket cerrado').setDescription(`Cerrado por <@${interaction.user.id}>.\n\nControles del equipo de soporte:`))], components: [closedTicketControls()], allowedMentions: { parse: [] } });
      return interaction.editReply({ content: 'Ticket cerrado.', components: [] }).catch(() => {});
    }
    if (interaction.isButton() && interaction.customId === 'ticket:reopen') {
      if (!isStaff(interaction)) return interaction.reply({ content: 'Solo el staff puede reabrir tickets.', flags: ephemeral });
      const ticket = ticketInfo(interaction.channel);
      if (!ticket || ticket.status !== 'closed') return interaction.reply({ content: 'Este ticket no está cerrado.', flags: ephemeral });
      await interaction.channel.permissionOverwrites.edit(ticket.owner, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
      await interaction.channel.setTopic(ticketStatusTopic(ticket.topic, 'open'));
      const order = findOrderByChannel(interaction.channelId); if (order) updateOrder(order.id, { status: 'pending' });
      await interaction.update({ components: [] });
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket:close').setLabel('Cerrar ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger));
      return interaction.channel.send({ content: `🔓 Ticket reabierto por <@${interaction.user.id}>.`, components: [row], allowedMentions: { parse: [] } });
    }
    if (interaction.isButton() && interaction.customId === 'ticket:delete') {
      if (!isStaff(interaction)) return interaction.reply({ content: 'Solo el staff puede borrar tickets.', flags: ephemeral });
      const ticket = ticketInfo(interaction.channel);
      if (!ticket || ticket.status !== 'closed') return interaction.reply({ content: 'Primero cierra el ticket.', flags: ephemeral });
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket:confirm-delete').setLabel('Sí, borrar canal').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId('ticket:cancel').setLabel('Cancelar').setStyle(ButtonStyle.Secondary));
      return interaction.reply({ content: '¿Borrar este canal y sus mensajes? Esta acción no se puede deshacer.', components: [row], flags: ephemeral });
    }
    if (interaction.isButton() && interaction.customId === 'ticket:confirm-delete') {
      if (!isStaff(interaction)) return interaction.reply({ content: 'Solo el staff puede borrar tickets.', flags: ephemeral });
      const ticket = ticketInfo(interaction.channel);
      if (!ticket || ticket.status !== 'closed') return interaction.update({ content: 'El ticket ya no está cerrado.', components: [] });
      await interaction.update({ content: 'Borrando ticket…', components: [] });
      return interaction.channel.delete(`Ticket borrado por ${interaction.user.tag}`);
    }
    if (interaction.isButton() && interaction.customId.startsWith('pay:')) {
      const [, action, type, owner] = interaction.customId.split(':');
      if (!isStaff(interaction) || interaction.user.id !== owner || !['tarjeta', 'paypal'].includes(type)) return interaction.reply({ content: 'Este control pertenece a otro miembro del staff.', flags: ephemeral });
      if (action === 'edit') {
        const saved = getPayment(interaction.guildId, owner, type);
        const field = (id, label, value, max = 100) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(max).setValue(value || ''));
        const modal = new ModalBuilder().setCustomId(`payment:save:${type}`).setTitle(`Registrar ${type}`);
        modal.addComponents(field('alias', 'Alias', saved?.alias, 40));
        if (type === 'tarjeta') modal.addComponents(field('number', 'Número de tarjeta', saved?.number, 25), field('bank', 'Banco', saved?.bank, 80), field('name', 'Nombre del titular', saved?.name, 100));
        else modal.addComponents(field('account', 'Correo o enlace de PayPal', saved?.account, 200), field('name', 'Nombre del titular', saved?.name, 100));
        return interaction.showModal(modal);
      }
      if (action === 'cancel') return interaction.update({ content: 'Cancelado.', components: [] });
      if (action === 'send') {
        const value = getPayment(interaction.guildId, owner, type); if (!value) return interaction.update({ content: 'No tienes este método guardado.', components: [] });
        const embed = decorate(new EmbedBuilder().setTitle(type === 'tarjeta' ? '💳 Datos de transferencia' : '🅿️ PayPal').addFields({ name: 'Alias', value: value.alias }, ...(type === 'tarjeta' ? [{ name: 'Tarjeta', value: value.number }, { name: 'Banco', value: value.bank }] : [{ name: 'PayPal', value: value.account }]), { name: 'Titular', value: value.name }));
        await interaction.update({ content: 'Método enviado.', components: [] });
        return interaction.channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
      }
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('payment:save:')) {
      if (!isStaff(interaction)) return interaction.reply({ content: 'Solo el staff puede configurar métodos de pago.', flags: ephemeral });
      const type = interaction.customId.split(':')[2]; if (!['tarjeta', 'paypal'].includes(type)) return interaction.reply({ content: 'Método inválido.', flags: ephemeral });
      const get = (field) => interaction.fields.getTextInputValue(field).trim(); const alias = get('alias');
      const other = aliasOwner(interaction.guildId, type, alias); if (other && other !== interaction.user.id) return interaction.reply({ content: 'Ese alias ya pertenece a otro miembro del staff. Elige otro.', flags: ephemeral });
      const value = type === 'tarjeta' ? { alias, number: get('number'), bank: get('bank'), name: get('name') } : { alias, account: get('account'), name: get('name') };
      if (Object.values(value).some((v) => !v)) return interaction.reply({ content: 'Completa todos los campos.', flags: ephemeral });
      savePayment(interaction.guildId, interaction.user.id, type, value);
      return interaction.reply({ content: `✅ Tu ${type} **${alias}** quedó guardado.`, flags: ephemeral });
    }
    if (interaction.isButton() && interaction.customId.startsWith('catalog:open:')) { const catalogId = interaction.customId.split(':')[2]; return interaction.reply({ ...catalogPanel(catalogId), flags: ephemeral }); }
    if (interaction.isButton() && interaction.customId.startsWith('help:')) { const section = interaction.customId.split(':')[1]; const admin = isAdmin(interaction); if (section === 'staff' && !admin) return interaction.reply({ content: 'Esta sección es solo para administradores.', flags: ephemeral }); const panel = helpPanel(admin, section, getPrefix(interaction.guildId, config.discord.defaultPrefix)); if (section === 'staff' || !interaction.message.flags.has(MessageFlags.Ephemeral)) return interaction.reply({ ...panel, flags: ephemeral }); return interaction.update(panel); }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('catalog:product:')) { const catalogId = interaction.customId.split(':')[2]; const product = productById(catalogId, interaction.values[0]); if (!product) return interaction.reply({ content: 'Ese producto ya no está disponible.', flags: ephemeral }); return interaction.reply({ ...checkoutPanel(catalogId, product), flags: ephemeral }); }
    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket:product') {
      if (interaction.channel?.topic !== `supportOwner=${interaction.user.id};status=open`) return interaction.reply({ content: 'Primero abre tu propio ticket con el botón del panel.', flags: ephemeral });
      return interaction.reply({ ...ticketPaymentPanel(interaction.values[0]), flags: ephemeral });
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('ticket:payment:')) {
      const catalogId = interaction.customId.split(':')[2]; const paymentId = interaction.values[0]; const payment = paymentById(paymentId);
      const catalog = catalogById(catalogId);
      if (!payment || !catalog) return interaction.reply({ content: 'Esa selección ya no está disponible.', flags: ephemeral });
      if (interaction.channel?.topic !== `supportOwner=${interaction.user.id};status=open`) return interaction.reply({ content: 'Este ticket ya tiene una selección o no te pertenece.', flags: ephemeral });
      await interaction.deferUpdate();
      const settings = getGuildSettings(interaction.guildId, { supportRoleId: config.discord.supportRoleId });
      const embed = decorate(new EmbedBuilder().setTitle('Pedido seleccionado').setDescription('El staff continuará la atención en este ticket.').addFields(
        { name: 'Cliente', value: `<@${interaction.user.id}>`, inline: true },
        { name: 'Producto', value: catalog.label, inline: true },
        { name: 'Método elegido', value: payment.label, inline: false }
      ));
      await interaction.channel.send({ content: `<@${interaction.user.id}>${settings.supportRoleId ? ` <@&${settings.supportRoleId}>` : ''}`, embeds: [embed], allowedMentions: { users: [interaction.user.id], roles: settings.supportRoleId ? [settings.supportRoleId] : [] } });
      await interaction.channel.setTopic(`supportOwner=${interaction.user.id};status=open;selected=1`);
      return interaction.deleteReply().catch(() => {});
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('catalog:payment:')) {
      const [, , catalogId, productId] = interaction.customId.split(':'); const paymentId = interaction.values[0];
      const modal = new ModalBuilder().setCustomId(`catalog:details:${catalogId}:${productId}:${paymentId}`).setTitle(catalogId === 'robux' ? 'Pedido de Robux' : 'Pedido de Nitro');
      const input = new TextInputBuilder().setCustomId('delivery').setLabel(catalogId === 'robux' ? 'Tu usuario de Roblox' : '¿Es para ti o para regalo?').setPlaceholder(catalogId === 'robux' ? 'Ejemplo: Builderman' : 'Para mí / Es un regalo').setStyle(TextInputStyle.Short).setMinLength(3).setMaxLength(catalogId === 'robux' ? 20 : 80).setRequired(true);
      return interaction.showModal(modal.addComponents(new ActionRowBuilder().addComponents(input)));
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('catalog:details:')) {
      const [, , catalogId, productId, paymentId] = interaction.customId.split(':');
      const product = productById(catalogId, productId); const payment = paymentById(paymentId); const detail = interaction.fields.getTextInputValue('delivery').trim();
      if (!product || !payment) return interaction.reply({ content: 'El producto o método de pago ya no está disponible.', flags: ephemeral });
      if (catalogId === 'robux' && !/^[A-Za-z0-9_]{3,20}$/.test(detail)) return interaction.reply({ content: 'Escribe un usuario de Roblox válido: 3–20 letras, números o guion bajo.', flags: ephemeral });
      await interaction.deferReply({ flags: ephemeral });
      const result = await createTicket(interaction, catalogId, product, payment, detail);
      return interaction.editReply(result.existing ? `Ya tienes un pedido de ${catalogById(catalogId).label} abierto: ${result.channel}` : `💗 ¡Listo! Bicha creó tu pedido en ${result.channel}.`);
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket:details:')) {
      const [, , catalogId, paymentId] = interaction.customId.split(':'); const payment = paymentById(paymentId); const catalog = catalogById(catalogId); const detail = interaction.fields.getTextInputValue('delivery').trim();
      if (!catalog || !payment) return interaction.reply({ content: 'Esa selección ya no está disponible.', flags: ephemeral });
      if (catalogId === 'robux' && paymentId !== 'support' && !/^[A-Za-z0-9_]{3,20}$/.test(detail)) return interaction.reply({ content: 'Escribe un usuario de Roblox válido: 3–20 letras, números o guion bajo.', flags: ephemeral });
      const product = { id: catalogId, label: catalog.label, price: paymentId === 'support' ? 'Consulta' : 'Por confirmar' };
      await interaction.deferReply({ flags: ephemeral });
      const result = await createTicket(interaction, catalogId, product, payment, detail);
      return interaction.editReply(result.existing ? `Ya tienes un ticket abierto: ${result.channel}` : `🎫 Tu ticket está listo: ${result.channel}`);
    }
    if (interaction.isButton() && interaction.customId.startsWith('order:')) {
      const order = findOrderByChannel(interaction.channelId); if (!order) return interaction.reply({ content: 'No encontré el pedido de este canal.', flags: ephemeral });
      const action = interaction.customId.split(':')[1];
      if (action !== 'close' && !isStaff(interaction)) return interaction.reply({ content: 'Solo el staff puede actualizar el pedido.', flags: ephemeral });
      if (action === 'close' && interaction.user.id !== order.userId && !isStaff(interaction)) return interaction.reply({ content: 'Solo el cliente o el staff puede cerrar este pedido.', flags: ephemeral });
      const nextStatus = action === 'close' ? 'closed' : action;
      const updated = updateOrder(order.id, { status: nextStatus });
      await interaction.channel.setTopic(`order=${order.id};owner=${order.userId};catalog=${order.catalogId};status=${nextStatus}`);
      await interaction.update({ embeds: [orderEmbed(updated)], components: [orderButtons(nextStatus)] });
      await interaction.channel.send(`${statusText(nextStatus)}${nextStatus === 'delivered' ? ' • ¡Gracias por comprar en Bicha!' : ''}`);
      return sendLog(interaction.guild, `${statusText(nextStatus)} · **${order.id}**`, orderEmbed(updated));
    }
  } catch (error) {
    console.error(error);
    if (!interaction.isRepliable()) return;
    const content = `No pude completar esa acción: ${error.message || 'revisa los permisos y la configuración.'}`;
    if (interaction.deferred || interaction.replied) await interaction.followUp({ content, flags: ephemeral }).catch(() => {});
    else await interaction.reply({ content, flags: ephemeral }).catch(() => {});
  }
});

async function handleMessage(message) {
  if (!message.guild || message.author.bot) return;
  const prefix = getPrefix(message.guild.id, config.discord.defaultPrefix);
  if (new RegExp(`^<@!?${client.user.id}>\\s*$`).test(message.content.trim())) return message.reply(`💗 Hola, soy **Bicha**. Mi prefijo aquí es \`${prefix}\`. Usa \`${prefix}help\` o \`/help\`.`);
  if (!message.content.startsWith(prefix)) return;
  const [rawCommand = '', ...args] = message.content.slice(prefix.length).trim().split(/\s+/); const command = rawCommand.toLowerCase();
  const staff = isStaff(message);
  if (['server', 'serverinfo', 'servidor'].includes(command)) return message.reply(serverInfo(message.guild));
  if (['serveravatar', 'servericon', 'serverbanner'].includes(command)) {
    const banner = command === 'serverbanner';
    const url = banner ? message.guild.bannerURL({ size: 2048 }) : message.guild.iconURL({ size: 1024 });
    return message.reply(imagePanel(`${banner ? '🌆 Banner' : '🖼️ Icono'} · ${message.guild.name}`, url, `Este servidor no tiene ${banner ? 'banner' : 'icono'} configurado.`));
  }
  if (['user', 'userinfo', 'usuario', 'avatar', 'banner'].includes(command)) {
    const targetArgs = command === 'user' && args[0]?.toLowerCase() === 'info' ? args.slice(1) : args;
    const person = await resolvePerson(message, targetArgs);
    if (!person) return message.reply(`No encontré a ese usuario. Usa una mención o un ID, por ejemplo \`${prefix}${command} @usuario\`.`);
    if (['user', 'userinfo', 'usuario'].includes(command)) return message.reply(userInfo(person.user, person.member));
    if (command === 'avatar') return message.reply(imagePanel(`🖼️ Avatar · ${person.user.globalName || person.user.username}`, person.user.displayAvatarURL({ size: 2048 }), 'Este usuario no tiene avatar.'));
    const user = await message.client.users.fetch(person.user.id, { force: true });
    return message.reply(imagePanel(`🌆 Banner · ${user.globalName || user.username}`, user.bannerURL({ size: 2048 }), 'Este usuario no tiene un banner de imagen configurado.'));
  }
  if (command === 'close' || command === 'delete') {
    const ticket = ticketInfo(message.channel);
    if (!ticket) return message.reply('Este comando solo funciona en canales de tickets de Bicha.');
    if (command === 'close') {
      if (ticket.owner !== message.author.id && !staff) return message.reply('Solo el cliente o el staff puede cerrar el ticket.');
      if (ticket.status === 'closed') return message.reply('Este ticket ya está cerrado.');
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket:confirm-close').setLabel('Cerrar ticket').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId('ticket:cancel').setLabel('Cancelar').setStyle(ButtonStyle.Secondary));
      return message.reply({ content: '¿Seguro que quieres cerrar este ticket?', components: [row] });
    }
    if (!staff) return message.reply('Solo el staff puede borrar tickets.');
    if (ticket.status !== 'closed') return message.reply(`Primero cierra el ticket con \`${prefix}close\`.`);
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket:confirm-delete').setLabel('Sí, borrar canal').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId('ticket:cancel').setLabel('Cancelar').setStyle(ButtonStyle.Secondary));
    return message.reply({ content: '¿Borrar este canal y sus mensajes? Esta acción no se puede deshacer.', components: [row] });
  }
  if (['tarjeta', 'paypal'].includes(command)) {
    if (!staff) return message.reply('Solo el staff puede usar los métodos de pago.');
    const saved = getPayment(message.guild.id, message.author.id, command); const requested = args.join(' ').trim();
    const owner = requested ? aliasOwner(message.guild.id, command, requested) : null;
    const edit = new ButtonBuilder().setCustomId(`pay:edit:${command}:${message.author.id}`).setLabel(saved ? 'Editar mis datos' : 'Registrar mis datos').setStyle(ButtonStyle.Primary);
    const row = new ActionRowBuilder().addComponents(edit);
    let content = saved ? `Tu ${command} está guardado como **${saved.alias}**. ¿Deseas enviarlo aquí?` : `Aún no tienes ${command} registrado. Pulsa para guardarlo.`;
    if (requested && owner && owner !== message.author.id) content = saved ? `Ese alias pertenece a otro usuario. Tu ${command} está guardado como **${saved.alias}**. ¿Deseas usarlo?` : 'Ese alias pertenece a otro usuario. Puedes registrar tu propio método.';
    else if (requested && saved && requested.toLowerCase() !== saved.alias.toLowerCase()) content = `Tu ${command} está guardado como **${saved.alias}**. ¿Deseas usarlo?`;
    if (saved) row.addComponents(new ButtonBuilder().setCustomId(`pay:send:${command}:${message.author.id}`).setLabel('Sí, enviar').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`pay:cancel:${command}:${message.author.id}`).setLabel('No').setStyle(ButtonStyle.Secondary));
    return message.reply({ content, components: [row], allowedMentions: { parse: [] } });
  }
  if (['purge', 'c', 'purbots', 'pbots'].includes(command)) {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return message.reply('Necesitas el permiso Gestionar mensajes.');
    const bots = ['purbots', 'pbots'].includes(command) || args[0]?.toLowerCase() === 'bots';
    const raw = bots && args[0]?.toLowerCase() === 'bots' ? args[1] : args[0]; const amount = raw ? Number(raw) : bots ? 100 : NaN;
    if (!Number.isInteger(amount) || amount < 1 || amount > 1000) return message.reply(`Uso: ${prefix}purge <1-1000> o ${prefix}purge bots [1-1000].`);
    let before; let scanned = 0; const selected = []; const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    while (selected.length < amount && scanned < 1000) { const batch = await message.channel.messages.fetch({ limit: 100, before }); if (!batch.size) break; scanned += batch.size; for (const item of batch.values()) { if (item.createdTimestamp < cutoff) break; if (!bots || item.author.bot) selected.push(item); if (selected.length >= amount) break; } const last = batch.last(); if (!last || last.createdTimestamp < cutoff || batch.size < 100) break; before = last.id; }
    let count = 0; for (let i = 0; i < selected.length; i += 100) { const batch = selected.slice(i, i + 100); if (batch.length === 1) { await batch[0].delete(); count++; } else count += (await message.channel.bulkDelete(batch, true)).size; }
    return message.channel.send(`🧹 Se borraron **${count}** mensajes${bots ? ' de bots' : ''}.`);
  }
  if (['help', 'ayuda'].includes(command)) return message.reply(helpPanel(isAdmin(message), 'home', prefix));
  if (command === 'prefix' || command === 'prefijo') { if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) return message.reply('Solo administradores pueden cambiar el prefijo.'); const next = args[0]; if (!next || !/^\S{1,5}$/.test(next)) return message.reply(`Uso: \`${prefix}prefix <nuevo>\``); setPrefix(message.guild.id, next); return message.reply(`✅ Mi nuevo prefijo es \`${next}\`.`); }
  if (command === 'embed' && args[0]?.toLowerCase() === 'edit') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) return message.reply('Solo administradores pueden editar el panel.');
    const recent = await message.channel.messages.fetch({ limit: 100 });
    const target = recent.find((item) => item.author.id === client.user.id && item.components.some((row) => row.components.some((component) => component.customId === 'ticket:open')));
    if (!target) return message.reply('No encontré un panel de tickets reciente en este canal. Usa el comando en el mismo canal donde está publicado.');
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`embed:edit:${target.id}`).setLabel('Editar embed').setEmoji('✏️').setStyle(ButtonStyle.Primary));
    return message.reply({ content: 'Pulsa para editar el panel de tickets de este canal.', components: [row] });
  }
  if (command === 'panel') { if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) return message.reply('Solo administradores pueden publicar paneles.'); const type = args[0] || 'principal'; if (!['principal', 'robux', 'nitro'].includes(type)) return message.reply(`Uso: \`${prefix}panel principal|robux|nitro\``); return message.channel.send(type === 'principal' ? mainPanel() : catalogPanel(type)); }
  if (command === 'ticket' && args[0]?.toLowerCase() === 'setup') { if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) return message.reply('Solo administradores pueden configurar tickets.'); return message.channel.send(ticketSetupInterface(message.guild.id)); }
  if (['play', 'p', 'queue', 'cola', 'skip', 'stop', 'vc', 'leave', 'salir'].includes(command)) {
    if (['leave', 'salir'].includes(command)) { if (!staff) return message.reply('Solo el staff puede desconectarme.'); music.disconnect(message.guild.id); return message.reply('👋 Bicha salió del canal.'); }
    const voice = message.member.voice.channel; if (!voice) return message.reply('Únete primero a un canal de voz.');
    if (['play', 'p'].includes(command)) { if (!args[0]) return message.reply(`Uso: \`${prefix}play <URL de YouTube>\``); const track = await music.enqueue(message.guild, voice, args[0], message.author.username); return message.reply(`🎶 Añadido: **${track.title}**`); }
    if (['queue', 'cola'].includes(command)) { const state = music.status(message.guild.id); return message.reply(state?.current ? `🎶 Sonando: **${state.current.title}** · ${state.queue.length} en cola.` : 'La cola está vacía.'); }
    if (command === 'skip') return message.reply(music.skip(message.guild.id) ? '⏭️ Canción saltada.' : 'No hay música sonando.');
    if (command === 'stop') { music.stop(message.guild.id); return message.reply('⏹️ Música detenida.'); }
    if (command === 'vc') { if (!staff) return message.reply('Solo el staff puede conectar a Bicha.'); await music.connect(message.guild, voice); return message.reply(`🔊 Conectada a **${voice.name}**. Me quedaré aquí hasta que uses \`${prefix}leave\` o se reinicie el bot.`); }
  }
}

client.on(Events.MessageCreate, (message) => {
  handleMessage(message).catch((error) => {
    console.error('[Comando por prefijo]', error);
    message.reply(`No pude completar esa acción: ${error.message || 'error inesperado.'}`).catch(() => {});
  });
});

client.login(token);
