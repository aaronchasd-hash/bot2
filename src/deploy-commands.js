import 'dotenv/config';
import { PermissionFlagsBits, REST, Routes, SlashCommandBuilder } from 'discord.js';

const token = process.env.DISCORD_TOKEN?.trim();
const clientId = process.env.CLIENT_ID?.trim();
if (!token || !clientId) throw new Error('Completa DISCORD_TOKEN y CLIENT_ID en .env.');
const commands = [
  new SlashCommandBuilder().setName('help').setDescription('Abre el panel de ayuda de Bicha.').setDMPermission(false),
  new SlashCommandBuilder().setName('panel').setDescription('Publica un panel de Bicha.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
    .addStringOption((option) => option.setName('tipo').setDescription('Panel que quieres publicar').setRequired(true).addChoices({ name: 'Panel principal', value: 'principal' }, { name: 'Robux', value: 'robux' }, { name: 'Discord Nitro', value: 'nitro' })),
  new SlashCommandBuilder().setName('pedidos').setDescription('Muestra los pedidos abiertos.').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels).setDMPermission(false),
  new SlashCommandBuilder().setName('prefijo').setDescription('Cambia el prefijo de Bicha.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false).addStringOption((option) => option.setName('nuevo').setDescription('Entre 1 y 5 caracteres').setRequired(true)),
  new SlashCommandBuilder().setName('ticket').setDescription('Configura el sistema de tickets de Bicha.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
    .addSubcommand((sub) => sub.setName('setup').setDescription('Publica el panel para abrir tickets de compra.')),
  new SlashCommandBuilder().setName('musica').setDescription('Controla la música y el canal de voz.').setDMPermission(false)
    .addSubcommand((sub) => sub.setName('play').setDescription('Reproduce un enlace de YouTube.').addStringOption((option) => option.setName('url').setDescription('Enlace de YouTube').setRequired(true)))
    .addSubcommand((sub) => sub.setName('cola').setDescription('Muestra la cola actual.'))
    .addSubcommand((sub) => sub.setName('skip').setDescription('Salta la canción actual.'))
    .addSubcommand((sub) => sub.setName('stop').setDescription('Detiene y vacía la cola.'))
    .addSubcommand((sub) => sub.setName('salir').setDescription('Desconecta a Bicha del canal de voz.'))
].map((command) => command.toJSON());
const rest = new REST({ version: '10' }).setToken(token);
const route = process.env.GUILD_ID?.trim() ? Routes.applicationGuildCommands(clientId, process.env.GUILD_ID.trim()) : Routes.applicationCommands(clientId);
await rest.put(route, { body: commands });
console.log(`✓ ${commands.length} comandos de Bicha registrados.`);
