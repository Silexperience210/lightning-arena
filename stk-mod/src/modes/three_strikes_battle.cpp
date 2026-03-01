//  SuperTuxKart - a fun racing game with go-kart
//  Copyright (C) 2006-2015 SuperTuxKart-Team
//
//  This program is free software; you can redistribute it and/or
//  modify it under the terms of the GNU General Public License
//  as published by the Free Software Foundation; either version 3
//  of the License, or (at your option) any later version.
//
//  This program is distributed in the hope that it will be useful,
//  but WITHOUT ANY WARRANTY; without even the implied warranty of
//  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
//  GNU General Public License for more details.
//
//  You should have received a copy of the GNU General Public License
//  along with this program; if not, write to the Free Software
//  Foundation, Inc., 59 Temple Place - Suite 330, Boston, MA  02111-1307, USA.

#include "modes/three_strikes_battle.hpp"

#include "guiengine/engine.hpp"
#include "guiengine/scalable_font.hpp"
#include "main_loop.hpp"
#include "audio/music_manager.hpp"
#include "config/user_config.hpp"
#include "graphics/camera.hpp"
#include "graphics/irr_driver.hpp"
#include <ge_render_info.hpp>
#include "io/file_manager.hpp"
#include "karts/kart.hpp"
#include "karts/controller/spare_tire_ai.hpp"
#include "karts/kart_model.hpp"
#include "karts/kart_properties.hpp"
#include "karts/kart_properties_manager.hpp"
#include "physics/physics.hpp"
#include "states_screens/race_gui_base.hpp"
#include "tracks/arena_graph.hpp"
#include "tracks/arena_node.hpp"
#include "tracks/terrain_info.hpp"
#include "tracks/track.hpp"
#include "tracks/track_object_manager.hpp"
#include "utils/constants.hpp"
#include "utils/string_utils.hpp"
#include "utils/translation.hpp"

// LIGHTNING ARENA - Bitcoin Maxi includes
#include "items/powerup.hpp"
#include "items/powerup_manager.hpp"
#include "network/network_config.hpp"
#include "network/protocols/game_events_protocol.hpp"
#include "network/protocol_manager.hpp"
#include <curl/curl.h>
#include <sstream>
#include <iostream>
#include <iomanip>

// LIGHTNING ARENA - Crypto pour anti-triche
// Implémentation HMAC-SHA256 simplifiée sans dépendance OpenSSL
#include <time.h>

#include <algorithm>
#include <deque>
#include <map>
#include <string>
#include <IMeshSceneNode.h>

// LIGHTNING ARENA - HUD uses getRaceGUI()->addMessage()

//-----------------------------------------------------------------------------
/** Constructor. Sets up the clock mode etc.
 */
ThreeStrikesBattle::ThreeStrikesBattle() : WorldWithRank()
{
    WorldStatus::setClockMode(CLOCK_CHRONO);
    m_use_highscores = false;
    m_insert_tire = 0;

    m_tire = irr_driver->getMesh(file_manager->getAsset(FileManager::MODEL,
                                 "tire.spm") );
    irr_driver->grabAllTextures(m_tire);

    m_total_rescue = 0;
    m_frame_count = 0;
    m_start_time = irr_driver->getRealTime();
    m_total_hit = 0;

    // LIGHTNING ARENA - Initialisation Bitcoin Maxi
    m_total_hits_given = 0;
    
    // Lire arguments ligne de commande
    parseLightningArgs();
    
    Log::info("LightningArena", "ThreeStrikesBattle initialisé - Mode Bitcoin Maxi");
    Log::info("LightningArena", "Server: %s", m_lightning_server_url.c_str());
    Log::info("LightningArena", "Ticket: %s", m_lightning_ticket_id.c_str());

}   // ThreeStrikesBattle

//-----------------------------------------------------------------------------
/** Initialises the three strikes battle. It sets up the data structure
 *  to keep track of points etc. for each kart.
 */
void ThreeStrikesBattle::init()
{
    WorldWithRank::init();
    m_display_rank = false;
    m_kart_info.resize(m_karts.size());
    
    // LIGHTNING ARENA - Initialiser les soldes P2P
    m_player_sats.resize(m_karts.size(), STARTING_SATS);
    
    Log::info("LightningArena", "=== ÉCONOMIE P2P INITIALISÉE ===");
    Log::info("LightningArena", "%d joueurs, %d sats chacun", (int)m_karts.size(), STARTING_SATS);
    Log::info("LightningArena", "Total en jeu: %d sats", (int)m_karts.size() * STARTING_SATS);
    Log::info("LightningArena", "==================================");
    
    // Afficher HUD de démarrage
    initLightningHUD();
}

//-----------------------------------------------------------------------------
/** Destructor. Clears all internal data structures, and removes the tire mesh
 *  from the mesh cache.
 */
ThreeStrikesBattle::~ThreeStrikesBattle()
{
    m_tires.clearWithoutDeleting();
    m_spare_tire_karts.clear();

    irr_driver->dropAllTextures(m_tire);
    // Remove the mesh from the cache so that the mesh is properly
    // freed once all refernces to it (which will happen once all
    // karts are being freed, which would have a pointer to this mesh)
    irr_driver->removeMeshFromCache(m_tire);
}   // ~ThreeStrikesBattle

//-----------------------------------------------------------------------------
/** Called when a battle is restarted.
 */
void ThreeStrikesBattle::reset(bool restart)
{
    WorldWithRank::reset(restart);

    float next_spawn_time =
        RaceManager::get()->getDifficulty() == RaceManager::DIFFICULTY_BEST ? 40.0f :
        RaceManager::get()->getDifficulty() == RaceManager::DIFFICULTY_HARD ? 30.0f :
        RaceManager::get()->getDifficulty() == RaceManager::DIFFICULTY_MEDIUM ?
        25.0f : 20.0f;
    m_next_sta_spawn_ticks = stk_config->time2Ticks(next_spawn_time);

    const unsigned int kart_amount = (unsigned int)m_karts.size();
    for(unsigned int n=0; n<kart_amount; n++)
    {
        if (dynamic_cast<SpareTireAI*>(m_karts[n]->getController()) != NULL)
        {
            // STA has no life
            m_kart_info[n].m_lives = 0;
        }
        else
        {
            m_kart_info[n].m_lives = 3;
        }

        // no positions in this mode
        m_karts[n]->setPosition(-1);

        scene::ISceneNode* kart_node = m_karts[n]->getNode();

        for (unsigned i = 0; i < kart_node->getChildren().size(); i++)
        {
            scene::ISceneNode* curr = kart_node->getChildren()[i];

            if (core::stringc(curr->getName()) == "tire1")
            {
                curr->setVisible(true);
            }
            else if (core::stringc(curr->getName()) == "tire2")
            {
                curr->setVisible(true);
            }
        }

    }// next kart

    // remove old battle events
    m_battle_events.clear();

    // add initial battle event
    BattleEvent evt;
    evt.m_time = 0.0f;
    evt.m_kart_info = m_kart_info;
    m_battle_events.push_back(evt);

    TrackObject *obj;
    for_in(obj, m_tires)
    {
        Track::getCurrentTrack()->getTrackObjectManager()->removeObject(obj);
    }
    m_tires.clearWithoutDeleting();

    // Finish all spare tire karts first
    if (!m_spare_tire_karts.empty())
    {
        updateKartRanks();
        for (unsigned int i = 0; i < m_spare_tire_karts.size(); i++)
        {
             m_spare_tire_karts[i]->finishedRace(0.0f);
             m_spare_tire_karts[i]->getNode()->setVisible(false);
             m_eliminated_karts++;
        }
    }
}   // reset

//-----------------------------------------------------------------------------
/** Adds two tires to each of the kart. The tires are used to represent
 *  lifes.
 *  \param kart The pointer to the kart (not used here).
 *  \param node The scene node of this kart.
 */
void ThreeStrikesBattle::kartAdded(AbstractKart* kart, scene::ISceneNode* node)
{
    if (!node)
        return;
    if (kart->getType() == RaceManager::KartType::KT_SPARE_TIRE)
    {
        // Add heart billboard above it
        std::string heart_path =
            file_manager->getAsset(FileManager::GUI_ICON, "heart.png");
        float height = kart->getKartHeight() + 0.5f;

        scene::ISceneNode* billboard = irr_driver->addBillboard
            (core::dimension2d<irr::f32>(0.8f, 0.8f), heart_path,
            kart->getNode());
        billboard->setPosition(core::vector3df(0, height, 0));
        return;
    }

    float coord = -kart->getKartLength()*0.5f;

    scene::ISceneNode* tire_node = irr_driver->addMesh(m_tire, "3strikestire", node);
    tire_node->setPosition(core::vector3df(-0.16f, 0.3f, coord - 0.25f));
    tire_node->setScale(core::vector3df(0.4f, 0.4f, 0.4f));
    tire_node->setRotation(core::vector3df(90.0f, 0.0f, 0.0f));
    tire_node->setName("tire1");

    tire_node = irr_driver->addMesh(m_tire, "3strikestire", node);
    tire_node->setPosition(core::vector3df(0.16f, 0.3f, coord - 0.25f));
    tire_node->setScale(core::vector3df(0.4f, 0.4f, 0.4f));
    tire_node->setRotation(core::vector3df(90.0f, 0.0f, 0.0f));
    tire_node->setName("tire2");
}   // kartAdded

//-----------------------------------------------------------------------------
/** Called when a kart is hit.
 *  \param kart_id The world kart id of the kart that was hit.
 *  \param hitter The world kart id of the kart who hit(-1 if none).
 */
bool ThreeStrikesBattle::kartHit(int kart_id, int hitter, int weapon_type)
{
    if (isRaceOver()) return false;

    SpareTireAI* sta =
        dynamic_cast<SpareTireAI*>(m_karts[kart_id]->getController());
    if (sta)
    {
        // Unspawn the spare tire kart if it get hit
        sta->unspawn();
        return false;
    }

    assert(kart_id < (int)m_karts.size());
    // make kart lose a life, ignore if in profiling mode
    if (!UserConfigParams::m_arena_ai_stats)
        m_kart_info[kart_id].m_lives--;
    else
        m_total_hit++;

    // record event
    BattleEvent evt;
    evt.m_time = getTime();
    evt.m_kart_info = m_kart_info;
    m_battle_events.push_back(evt);

    updateKartRanks();
    // check if kart is 'dead' (0 sats = élimination)
    if (m_player_sats[kart_id] <= 0)
    {
        if (getCurrentNumPlayers())
            lightningEliminateKart(kart_id, /*notify_of_elimination*/ true);
        m_karts[kart_id]->finishedRace(WorldStatus::getTime());
        scene::ISceneNode** wheels = m_karts[kart_id]->getKartModel()
                                                     ->getWheelNodes();
        if(wheels[0]) wheels[0]->setVisible(false);
        if(wheels[1]) wheels[1]->setVisible(false);
        if(wheels[2]) wheels[2]->setVisible(false);
        if(wheels[3]) wheels[3]->setVisible(false);
        // Find a camera of the kart with the most lives ("leader"), and
        // attach all cameras for this kart to the leader.
        int max_lives = 0;
        AbstractKart *leader = NULL;
        for(unsigned int i=0; i<getNumKarts(); i++)
        {
            AbstractKart * const kart = getKart(i);
            if(kart->isEliminated() || kart->hasFinishedRace() ||
                kart->getWorldKartId()==(unsigned)kart_id) continue;
            if(m_kart_info[i].m_lives > max_lives)
            {
                leader = kart;
                max_lives = m_kart_info[i].m_lives;
            }
        }
        // leader could be 0 if the last two karts hit each other in
        // the same frame
        if(leader && getCurrentNumPlayers())
        {
            for(unsigned int i=0; i<Camera::getNumCameras(); i++)
            {
                Camera *camera = Camera::getCamera(i);
                if(camera->getKart()->getWorldKartId()==(unsigned)kart_id)
                {
                    camera->setMode(Camera::CM_NORMAL);
                    camera->setKart(leader);
                }
            }   // for in < number of cameras
        }   // if leader
        m_insert_tire = 4;
    }

    const unsigned int NUM_KARTS = getNumKarts();
    int num_karts_many_lives = 0;

    for (unsigned int n = 0; n < NUM_KARTS; ++n)
    {
        if (m_kart_info[n].m_lives > 1) num_karts_many_lives++;
    }

    // when almost over, use fast music
    if (num_karts_many_lives<=1 && !m_faster_music_active)
    {
        music_manager->switchToFastMusic();
        m_faster_music_active = true;
    }

    scene::ISceneNode* kart_node = m_karts[kart_id]->getNode();
    for (unsigned i = 0; i < kart_node->getChildren().size(); i++)
    {
        scene::ISceneNode* curr = kart_node->getChildren()[i];

        if (core::stringc(curr->getName()) == "tire1")
        {
            curr->setVisible(m_kart_info[kart_id].m_lives >= 3);
        }
        else if (core::stringc(curr->getName()) == "tire2")
        {
            curr->setVisible(m_kart_info[kart_id].m_lives >= 2);
        }
    }

    // schedule a tire to be thrown away (but can't do it in this callback
    // because the caller is currently iterating the list of track objects)
    m_insert_tire++;
    core::vector3df wheel_pos(m_karts[kart_id]->getKartWidth()*0.5f,
                              0.0f, 0.0f);
    m_tire_position = kart_node->getPosition() + wheel_pos;
    m_tire_rotation = 0;
    if(m_insert_tire > 1)
    {
        m_tire_position = kart_node->getPosition();
        m_tire_rotation = m_karts[kart_id]->getHeading();
    }

    for(unsigned int i=0; i<4; i++)
    {
        m_tire_offsets[i] = m_karts[kart_id]->getKartModel()
                            ->getWheelGraphicsPosition(i).toIrrVector();
        m_tire_offsets[i].rotateXZBy(-m_tire_rotation / M_PI * 180 + 180);
        m_tire_radius[i] = m_karts[kart_id]->getKartModel()
                                           ->getWheelGraphicsRadius(i);
    }

    m_tire_dir = m_karts[kart_id]->getKartProperties()->getKartDir();
    if(m_insert_tire == 5 && m_karts[kart_id]->isWheeless())
        m_insert_tire = 0;
    
    // LIGHTNING ARENA - SYSTÈME ÉCONOMIQUE P2P (Authoritative Server)
    // Seul le serveur calcule et broadcast les transferts
    // Les clients appliquent uniquement ce qui vient du réseau
    if (hitter >= 0 && hitter != kart_id)
    {
        bool is_server = NetworkConfig::get()->isServer();
        bool is_client = NetworkConfig::get()->isClient();
        
        // Déterminer l'arme utilisée
        AbstractKart* hitter_kart = m_karts[hitter].get();
        std::string weapon = "collision";
        
        if (weapon_type >= 0)
        {
            weapon = powerupTypeToString(weapon_type);
            Log::info("LightningArena", "PROJECTILE HIT: weapon=%s (type=%d)", weapon.c_str(), weapon_type);
        }
        
        int reward = calculateReward(weapon);
        
        if (is_server)
        {
            // SERVEUR: Calculer, appliquer et broadcaster
            Log::info("LightningArena", "SERVER HIT: Kart %d hit %d with %s (reward=%d)",
                     hitter, kart_id, weapon.c_str(), reward);
            
            int actual_reward = reward;
            if (m_player_sats[kart_id] < reward)
            {
                actual_reward = m_player_sats[kart_id];  // Prendre tout ce qui reste
            }
            
            // Appliquer localement
            m_player_sats[hitter] += actual_reward;
            m_player_sats[kart_id] -= actual_reward;
            
            // Broadcast à tous les clients
            auto pm = ProtocolManager::lock();
            if (pm)
            {
                auto proto = pm->getProtocol(PROTOCOL_GAME_EVENTS);
                auto gep = std::dynamic_pointer_cast<GameEventsProtocol>(proto);
                if (gep)
                {
                    gep->sendLightningTransfer(kart_id, hitter, actual_reward, weapon_type);
                    Log::info("LightningArena", "BROADCAST: Transfer %d sats from %d to %d",
                             actual_reward, kart_id, hitter);
                }
            }
            
            // Afficher popup pour joueur local sur serveur
            AbstractKart* local_kart = getLocalPlayerKart(0);
            if (local_kart)
            {
                int local_id = local_kart->getWorldKartId();
                if (local_id == hitter)
                    showSatsPopup(actual_reward, true);
                else if (local_id == kart_id)
                    showSatsPopup(-actual_reward, false);
            }
            
            // Vérifier élimination
            if (m_player_sats[kart_id] <= 0 && !m_karts[kart_id]->isEliminated())
            {
                Log::info("LightningArena", "☠️ ÉLIMINATION: Kart %d ruiné!", kart_id);
                RaceGUIBase* gui = getRaceGUI();
                if (gui)
                {
                    core::stringw elim_msg = m_karts[kart_id]->getName();
                    elim_msg += L" est RUINÉ! ☠️";
                    gui->addMessage(elim_msg, nullptr, 3.0f,
                                   video::SColor(255, 255, 0, 0), true, true, false);
                }
                
                // LIGHTNING ARENA - Mode spectateur si joueur local éliminé
                AbstractKart* local_kart = getLocalPlayerKart(0);
                if (local_kart && m_karts[kart_id].get() == local_kart)
                {
                    // Activer le mode spectateur
                    Camera* cam = Camera::getCamera(0);
                    if (cam)
                    {
                        cam->setMode(Camera::CM_SPECTATOR_TOP_VIEW);
                        if (gui)
                        {
                            gui->addMessage(_("Mode SPECTATEUR - Appuyez sur 'V' pour changer de vue"),
                                           nullptr, 5.0f,
                                           video::SColor(255, 247, 147, 26),
                                           true, true, false);
                        }
                        Log::info("LightningArena", "📹 Mode spectateur activé pour joueur local");
                    }
                }
                
                lightningEliminateKart(kart_id, true);
                m_karts[kart_id]->finishedRace(WorldStatus::getTime());
            }
            
            // Stats
            if (local_kart && hitter_kart == local_kart)
                m_total_hits_given++;
        }
        else if (!is_client)
        {
            // MODE LOCAL (pas réseau): Comportement original
            Log::info("LightningArena", "LOCAL HIT: %d sats from %d to %d", reward, kart_id, hitter);
            
            if (m_player_sats[kart_id] >= reward)
            {
                m_player_sats[hitter] += reward;
                m_player_sats[kart_id] -= reward;
            }
            else
            {
                int remaining = m_player_sats[kart_id];
                m_player_sats[hitter] += remaining;
                m_player_sats[kart_id] = 0;
            }
            
            // Afficher popup
            AbstractKart* local_kart = getLocalPlayerKart(0);
            if (local_kart)
            {
                if (hitter_kart == local_kart)
                    showSatsPopup(reward, true);
                else if (m_karts[kart_id].get() == local_kart)
                    showSatsPopup(-reward, false);
            }
            
            // Élimination
            if (m_player_sats[kart_id] <= 0 && !m_karts[kart_id]->isEliminated())
            {
                Log::info("LightningArena", "☠️ ÉLIMINATION ÉCONOMIQUE: Kart %d ruiné!", kart_id);
                RaceGUIBase* gui = getRaceGUI();
                if (gui)
                {
                    core::stringw elim_msg = m_karts[kart_id]->getName();
                    elim_msg += L" est RUINÉ! ☠️";
                    gui->addMessage(elim_msg, nullptr, 3.0f,
                                   video::SColor(255, 255, 0, 0), true, true, false);
                }
                
                // LIGHTNING ARENA - Mode spectateur si joueur local éliminé (mode local)
                AbstractKart* local_kart = getLocalPlayerKart(0);
                if (local_kart && m_karts[kart_id].get() == local_kart)
                {
                    Camera* cam = Camera::getCamera(0);
                    if (cam)
                    {
                        cam->setMode(Camera::CM_SPECTATOR_TOP_VIEW);
                        if (gui)
                        {
                            gui->addMessage(_("Mode SPECTATEUR - Appuyez sur 'V' pour changer de vue"),
                                           nullptr, 5.0f,
                                           video::SColor(255, 247, 147, 26),
                                           true, true, false);
                        }
                        Log::info("LightningArena", "📹 Mode spectateur activé (mode local)");
                    }
                }
                
                lightningEliminateKart(kart_id, true);
                m_karts[kart_id]->finishedRace(WorldStatus::getTime());
            }
        }
        // CLIENTS: Ignorer le hit local, attendre l'événement du serveur
        else
        {
            Log::verbose("LightningArena", "CLIENT: Hit detected locally, waiting for server...");
        }
    }
    
    return true;
}   // kartHit

//-----------------------------------------------------------------------------
/** Returns the internal identifier for this race.
 */
const std::string& ThreeStrikesBattle::getIdent() const
{
    return IDENT_STRIKES;
}   // getIdent

//-----------------------------------------------------------------------------
/** Update the world and the track.
 *  \param ticks Number of physics time step - should be 1.
 */
void ThreeStrikesBattle::update(int ticks)
{
    WorldWithRank::update(ticks);
    WorldWithRank::updateTrack(ticks);

    // LIGHTNING ARENA - Cleanup des déconnexions anciennes (toutes les 10 sec)
    static int last_cleanup = 0;
    if (ticks - last_cleanup > stk_config->time2Ticks(10.0f))
    {
        cleanupOldDisconnections();
        last_cleanup = ticks;
    }

    spawnSpareTireKarts();
    if (Track::getCurrentTrack()->hasNavMesh())
        updateSectorForKarts();

    // insert blown away tire(s) now if was requested
    while (m_insert_tire > 0)
    {
        std::string tire;
        core::vector3df tire_offset;
        float scale = 0.5f;
        float radius = 0.5f;
        PhysicalObject::BodyTypes body_shape;
        if(m_insert_tire == 1)
        {
            tire_offset = core::vector3df(0.0f, 0.0f, 0.0f);
            tire = file_manager->getAsset(FileManager::MODEL,"tire.spm");
            scale = 0.5f;
            radius = 0.5f;
            body_shape = PhysicalObject::MP_CYLINDER_Y;
        }
        else
        {
            scale = 1.0f;
            body_shape = PhysicalObject::MP_CYLINDER_X;
            radius = m_tire_radius[m_insert_tire-2];
            tire_offset = m_tire_offsets[m_insert_tire-2];
            if     (m_insert_tire == 2)
                tire = m_tire_dir+"/wheel-rear-left.spm";
            else if(m_insert_tire == 3)
                tire = m_tire_dir+"/wheel-front-left.spm";
            else if(m_insert_tire == 4)
                tire = m_tire_dir+"/wheel-front-right.spm";
            else if(m_insert_tire == 5)
                tire = m_tire_dir+"/wheel-rear-right.spm";
            if(!file_manager->fileExists(tire))
            {
                m_insert_tire--;
                if(m_insert_tire == 1)
                    m_insert_tire = 0;
                continue;
            }
        }


        core::vector3df tire_xyz = m_tire_position + tire_offset;
        core::vector3df tire_hpr = core::vector3df(800.0f,0,
                                                   m_tire_rotation *RAD_TO_DEGREE + 180);
        core::vector3df tire_scale(scale,scale,scale);

        PhysicalObject::Settings physics_settings(body_shape,
                                                  radius, /*mass*/15.0f);

        TrackObjectPresentationMesh* tire_presentation =
            new TrackObjectPresentationMesh(tire, tire_xyz, tire_hpr, tire_scale);

#ifdef DEBUG
        tire_presentation->getNode()->setName("Tire on ground");
#endif

        TrackObject* tire_obj = new TrackObject(tire_xyz, tire_hpr, tire_scale,
                                                "movable", tire_presentation,
                                                true /* is_dynamic */,
                                                &physics_settings);
        Track::getCurrentTrack()->getTrackObjectManager()->insertObject(tire_obj);

        // FIXME: orient the force relative to kart orientation
        tire_obj->getPhysicalObject()->getBody()
                ->applyCentralForce(btVector3(60.0f, 0.0f, 0.0f));

        m_insert_tire--;
        if(m_insert_tire == 1)
            m_insert_tire = 0;

        m_tires.push_back(tire_obj);
    }   // while
    if (UserConfigParams::m_arena_ai_stats)
        m_frame_count++;
    
    // LIGHTNING ARENA - Mettre à jour le HUD Bitcoin
    updateLightningHUD(ticks);

}   // update

//-----------------------------------------------------------------------------
/** LIGHTNING ARENA - Rendu graphique du HUD (désactivé, utilise addMessage) */
void ThreeStrikesBattle::updateGraphics(float dt)
{
    WorldWithRank::updateGraphics(dt);
    // Le HUD est dessiné via addMessage dans updateLightningHUD
}

//-----------------------------------------------------------------------------
/** Updates the ranking of the karts.
 */
void ThreeStrikesBattle::updateKartRanks()
{
    beginSetKartPositions();
    // sort karts by their times then give each one its position.
    // in battle-mode, long time = good (meaning he survived longer)

    const unsigned int NUM_KARTS = getNumKarts();

    std::vector<KartValues> karts_list;
    for( unsigned int n = 0; n < NUM_KARTS; ++n )
    {
        KartValues k;
        k.id = n;
        k.time = m_karts[n]->hasFinishedRace() ? (int)m_karts[n]->getFinishTime()
                                               : (int)WorldStatus::getTime();
        k.lives = m_kart_info[n].m_lives;
        karts_list.push_back(k);
    }

    std::sort(karts_list.rbegin(), karts_list.rend());

    for( unsigned int n = 0; n < NUM_KARTS; ++n )
    {
        setKartPosition(karts_list[n].id, n+1);
    }

    endSetKartPositions();
}   // updateKartRank

//-----------------------------------------------------------------------------
/** The battle is over if only one kart is left, or no player kart.
 */
bool ThreeStrikesBattle::isRaceOver()
{
    if (UserConfigParams::m_arena_ai_stats)
        return (irr_driver->getRealTime()-m_start_time)*0.001f > 20.0f;

    // for tests : never over when we have a single player there :)
    if (RaceManager::get()->getNumberOfKarts() - m_spare_tire_karts.size () ==1 &&
        getCurrentNumKarts()==1 &&
        UserConfigParams::m_artist_debug_mode)
    {
        return false;
    }

    return getCurrentNumKarts()==1 || getCurrentNumPlayers()==0;
}   // isRaceOver

//-----------------------------------------------------------------------------
/** Called when the race finishes, i.e. after playing (if necessary) an
 *  end of race animation. It updates the time for all karts still racing,
 *  and then updates the ranks.
 */
void ThreeStrikesBattle::terminateRace()
{
    updateKartRanks();
    
    // LIGHTNING ARENA - RÉSULTATS FINAUX P2P
    Log::info("LightningArena", "========================================");
    Log::info("LightningArena", "🏆 PARTIE TERMINÉE - RÉSULTATS P2P");
    Log::info("LightningArena", "========================================");
    
    // LIGHTNING ARENA - CLASSEMENT COMPLET AVEC GESTION DES ÉGALITÉS
    int winner_id = -1;
    int winner_sats = 0;
    int total_in_game = 0;
    int max_sats = -1;
    
    // Structure pour le classement
    struct KartScore {
        int id;
        int sats;
        std::string name;
        bool eliminated;
    };
    std::vector<KartScore> rankings;
    
    for (unsigned int i = 0; i < getNumKarts(); i++)
    {
        total_in_game += m_player_sats[i];
        
        KartScore ks;
        ks.id = i;
        ks.sats = m_player_sats[i];
        ks.name = StringUtils::wideToUtf8(m_karts[i]->getName());
        ks.eliminated = m_karts[i]->isEliminated();
        rankings.push_back(ks);
        
        Log::info("LightningArena", "  Kart %d (%s): %d sats %s", 
                 i, ks.name.c_str(), m_player_sats[i],
                 ks.eliminated ? "[ELIMINÉ]" : "");
        
        // Chercher le max de sats
        if (!m_karts[i]->isEliminated() && m_player_sats[i] > max_sats)
        {
            max_sats = m_player_sats[i];
            winner_id = i;
            winner_sats = m_player_sats[i];
        }
    }
    
    // Détecter les égalités pour la 1ère place
    std::vector<int> tied_winners;
    for (unsigned int i = 0; i < getNumKarts(); i++)
    {
        if (!m_karts[i]->isEliminated() && m_player_sats[i] == max_sats)
        {
            tied_winners.push_back(i);
        }
    }
    
    // Trier le classement par sats décroissants
    std::sort(rankings.begin(), rankings.end(), 
              [](const KartScore& a, const KartScore& b) {
                  return a.sats > b.sats;
              });
    
    // Afficher le TOP 3
    Log::info("LightningArena", "🏆 CLASSEMENT FINAL:");
    int rank = 1;
    for (const auto& ks : rankings)
    {
        if (rank > 3) break;
        Log::info("LightningArena", "  #%d: %s - %d sats %s",
                 rank, ks.name.c_str(), ks.sats,
                 ks.eliminated ? "(éliminé)" : "");
        rank++;
    }
    
    if (winner_id >= 0)
    {
        Log::info("LightningArena", "🏆 GAGNANT: %s avec %d sats!", 
                 m_karts[winner_id]->getName().c_str(), winner_sats);
        Log::info("LightningArena", "Total en circulation: %d sats", total_in_game);
        
        // LIGHTNING ARENA - Fichier JSON de victoire signé pour anti-triche
        FILE* victory_file = fopen("C:\\Users\\Silex\\AppData\\Local\\Temp\\lightning_victory.json", "w");
        if (victory_file)
        {
            int timestamp = (int)time(NULL);
            int ticket_id = timestamp + winner_id * 1000;
            
            // Convertir le nom du gagnant
            std::string winner_name = StringUtils::wideToUtf8(m_karts[winner_id]->getName());
            
            // SIGNER LA VICTOIRE (anti-triche)
            std::string signature = signVictory(winner_name, winner_sats, timestamp, 
                                                LIGHTNING_SECRET_KEY);
            
            Log::info("LightningArena", "🔐 Signature HMAC: %s", signature.c_str());
            
            fprintf(victory_file, "{\n");
            fprintf(victory_file, "  \"status\": \"completed\",\n");
            fprintf(victory_file, "  \"winner\": \"%s\",\n", winner_name.c_str());
            fprintf(victory_file, "  \"winner_id\": %d,\n", winner_id);
            fprintf(victory_file, "  \"sats\": %d,\n", winner_sats);
            fprintf(victory_file, "  \"ln_address\": \"pending\",\n");
            fprintf(victory_file, "  \"ticket_id\": \"VICTORY-%d\",\n", ticket_id);
            fprintf(victory_file, "  \"timestamp\": %ld,\n", (long)timestamp);
            fprintf(victory_file, "  \"total_players\": %d,\n", (int)getNumKarts());
            fprintf(victory_file, "  \"game_mode\": \"lightning_arena\",\n");
            fprintf(victory_file, "  \"signature\": \"%s\",\n", signature.c_str());
            fprintf(victory_file, "  \"verified\": true\n");
            fprintf(victory_file, "}\n");
            fclose(victory_file);
            
            Log::info("LightningArena", "✅ Fichier victory.json signé créé (anti-triche actif)");
        }
        
        // Afficher message victoire
        RaceGUIBase* gui = getRaceGUI();
        if (gui)
        {
            core::stringw win_msg = L"🏆 ";
            win_msg += m_karts[winner_id]->getName().c_str();
            win_msg += L" GAGNE!\n[BTC] ";
            win_msg += winner_sats;
            win_msg += L" sats";
            
            gui->addMessage(win_msg, nullptr, 5.0f,
                           video::SColor(255, 255, 215, 0),
                           true, true, false);
        }
    }
    
    Log::info("LightningArena", "========================================");
    Log::info("LightningArena", "Hits donnés: %d", m_total_hits_given);
    Log::info("LightningArena", "========================================");
    
    WorldWithRank::terminateRace();
}   // terminateRace

//-----------------------------------------------------------------------------
/** Returns the data to display in the race gui.
 */
void ThreeStrikesBattle::getKartsDisplayInfo(
                           std::vector<RaceGUIBase::KartIconDisplayInfo> *info)
{
    const unsigned int kart_amount = getNumKarts();
    for(unsigned int i = 0; i < kart_amount ; i++)
    {
        RaceGUIBase::KartIconDisplayInfo& rank_info = (*info)[i];

        // reset color
        rank_info.lap = -1;

        switch(m_kart_info[i].m_lives)
        {
            case 3:
                rank_info.m_color = video::SColor(255, 0, 255, 0);
                break;
            case 2:
                rank_info.m_color = video::SColor(255, 255, 229, 0);
                break;
            case 1:
                rank_info.m_color = video::SColor(255, 255, 0, 0);
                break;
            case 0:
                rank_info.m_color = video::SColor(128, 128, 128, 0);
                break;
        }

        std::ostringstream oss;
        oss << m_kart_info[i].m_lives;

        rank_info.m_text = oss.str().c_str();
    }
}   // getKartsDisplayInfo

//-----------------------------------------------------------------------------
void ThreeStrikesBattle::enterRaceOverState()
{
    WorldWithRank::enterRaceOverState();

    // Unspawn all spare tire karts if neccesary
    for (unsigned int i = 0; i < m_spare_tire_karts.size(); i++)
    {
        SpareTireAI* sta =
            dynamic_cast<SpareTireAI*>(m_spare_tire_karts[i]->getController());
        assert(sta);
        if (sta->isMoving())
            sta->unspawn();
    }

    if (UserConfigParams::m_arena_ai_stats)
    {
        float runtime = (irr_driver->getRealTime()-m_start_time)*0.001f;
        Log::verbose("Battle AI profiling", "Number of frames: %d, Average FPS: %f",
            m_frame_count, (float)m_frame_count/runtime);
        Log::verbose("Battle AI profiling", "Total rescue: %d , hits %d in %f seconds",
            m_total_rescue, m_total_hit, runtime);
        delete this;
        main_loop->abort();
    }

}   // enterRaceOverState

//-----------------------------------------------------------------------------
bool ThreeStrikesBattle::spareTireKartsSpawned() const
{
    if (m_spare_tire_karts.empty()) return false;

    // Spare tire karts are spawned if at least 1 of them needs update
    SpareTireAI* sta =
        dynamic_cast<SpareTireAI*>(m_spare_tire_karts[0]->getController());
    assert(sta);

    return sta->isMoving();
}   // spareTireKartsSpawned

//-----------------------------------------------------------------------------
void ThreeStrikesBattle::addKartLife(unsigned int id)
{
    m_kart_info[id].m_lives++;
    updateKartRanks();

    scene::ISceneNode* kart_node = m_karts[id]->getNode();
    for (unsigned i = 0; i < kart_node->getChildren().size(); i++)
    {
        scene::ISceneNode* curr = kart_node->getChildren()[i];
        if (core::stringc(curr->getName()) == "tire1")
        {
            curr->setVisible(m_kart_info[id].m_lives >= 3);
        }
        else if (core::stringc(curr->getName()) == "tire2")
        {
            curr->setVisible(m_kart_info[id].m_lives >= 2);
        }
    }

}   // addKartLife

//-----------------------------------------------------------------------------
void ThreeStrikesBattle::spawnSpareTireKarts()
{
    if (m_spare_tire_karts.empty() ||
        getTicksSinceStart() < m_next_sta_spawn_ticks)
        return;

    // The lifespan for sta: inc_factor / period * 1000 / 2
    // So in easier mode the sta lasts longer than spawn period
    float inc_factor, lifespan;
    switch (RaceManager::get()->getDifficulty())
    {
    case RaceManager::DIFFICULTY_BEST: inc_factor = 0.7f;  lifespan = 17.5f;  break;
    case RaceManager::DIFFICULTY_HARD: inc_factor = 0.65f; lifespan = 21.66f; break;
    case RaceManager::DIFFICULTY_EASY: inc_factor = 0.6f;  lifespan = 24.0f;  break;
    default:                           inc_factor = 0.55f; lifespan = 27.5f;  break;
    }

    int lifespan_ticks = stk_config->time2Ticks(lifespan);
    // Spawn spare tire kart when necessary
    m_next_sta_spawn_ticks = int( lifespan_ticks
                                + getTicksSinceStart() * inc_factor
                                + getTicksSinceStart()             );
    int kart_has_few_lives = 0;
    for (unsigned int i = 0; i < m_kart_info.size(); i++)
    {
        if (m_kart_info[i].m_lives > 0 && m_kart_info[i].m_lives < 3)
            kart_has_few_lives++;
    }

    float ratio = kart_has_few_lives / (inc_factor * 2);
    if (ratio < 1.5f) return;
    unsigned int spawn_sta = unsigned(ratio);
    if (spawn_sta > m_spare_tire_karts.size())
        spawn_sta = (int)m_spare_tire_karts.size();
    if (m_race_gui)
    {
        m_race_gui->addMessage(_P("%i spare tire kart has been spawned!",
                                "%i spare tire karts have been spawned!",
                                spawn_sta), NULL, 2.0f);
    }
    for (unsigned int i = 0; i < spawn_sta; i++)
    {
        SpareTireAI* sta = dynamic_cast<SpareTireAI*>
            (m_spare_tire_karts[i]->getController());
        assert(sta);
        sta->spawn(lifespan_ticks);
    }
}   // spawnSpareTireKarts

//-----------------------------------------------------------------------------
void ThreeStrikesBattle::loadCustomModels()
{
    // Pre-add spare tire karts if there are more than certain number of karts
    ArenaGraph* ag = ArenaGraph::get();
    if (ag && m_karts.size() > 4)
    {
        // Spare tire karts only added with large arena
        const int all_nodes = ag->getNumNodes();
        if (all_nodes > 500)
        {
            // Don't create too many spare tire karts
            const unsigned int max_sta_num = unsigned(m_karts.size() * 0.8f);
            unsigned int pos_created = 0;
            std::deque<int> sta_possible_nodes;
            for (int i = 0; i < all_nodes; i++)
                sta_possible_nodes.push_back(i);
            std::vector<btTransform> pos;

            // Fill all current starting position into used first
            for (unsigned int i = 0; i < getNumberOfRescuePositions(); i++)
            {
                int node = -1;
                ag->findRoadSector(getRescueTransform(i).getOrigin(), &node,
                    NULL, true);
                assert(node != -1);
                sta_possible_nodes.erase(std::remove_if(
                    sta_possible_nodes.begin(), sta_possible_nodes.end(),
                    [node](const int n) { return n == node; }),
                    sta_possible_nodes.end());
            }

            // Find random nodes to pre-spawn spare tire karts
            std::random_shuffle(sta_possible_nodes.begin(),
                sta_possible_nodes.end());

            // Compute a random kart list
            std::vector<std::string> sta_list;
            kart_properties_manager->getRandomKartList(max_sta_num, NULL,
                &sta_list);
            if (sta_list.size() != max_sta_num)
                return;

            TerrainInfo terrain;
            while (!sta_possible_nodes.empty())
            {
                const int node = sta_possible_nodes.front();
                const ArenaNode* n = ag->getNode(node);
                btTransform t;
                t.setOrigin(n->getCenter());
                t.setRotation(shortestArcQuat(Vec3(0, 1, 0), n->getNormal()));

                // Make sure starting position is valid for spare tire karts,
                // see #4615
                terrain.update(t.getBasis(),
                    t.getOrigin() + t.getBasis() * Vec3(0, 0.3f, 0));
                Vec3 from = (Vec3)t.getOrigin();
                const KartProperties* kp = kart_properties_manager->getKart(
                    sta_list[pos.size()]);
                if (!kp)
                    return;
                float kh = kp->getMasterKartModel().getHeight();
                //start projection from top of kart
                Vec3 up_offset = terrain.getNormal() * (0.5f * kh);
                from += up_offset;
                Vec3 down = t.getBasis() * Vec3(0, -10000.0f, 0);

                Vec3 hit_point, normal;
                if (!Track::getCurrentTrack()->isOnGround(from, down,
                    &hit_point, &normal, false/*print_warning*/))
                {
                    sta_possible_nodes.pop_front();
                    continue;
                }
                pos.push_back(t);
                pos_created++;
                sta_possible_nodes.pop_front();
                if (pos_created == max_sta_num) break;
            }

            if (pos_created != max_sta_num)
                return;
            assert(sta_list.size() == pos.size());
            // Now add them
            for (unsigned int i = 0; i < pos.size(); i++)
            {
                auto sta = std::make_shared<Kart>(sta_list[i], (int)m_karts.size(),
                    (int)m_karts.size() + 1, pos[i], HANDICAP_NONE,
                    std::make_shared<GE::GERenderInfo>(1.0f));
                sta->init(RaceManager::KartType::KT_SPARE_TIRE);
                sta->setController(new SpareTireAI(sta.get()));

                m_karts.push_back(sta);
                RaceManager::get()->addSpareTireKart(sta_list[i]);

                // Copy STA pointer to m_spare_tire_karts array, allowing them
                // to respawn easily
                m_spare_tire_karts.push_back(sta.get());
            }
            unsigned int sta_num = RaceManager::get()->getNumSpareTireKarts();
            assert(m_spare_tire_karts.size() == sta_num);
            Log::info("ThreeStrikesBattle","%d spare tire kart(s) created.",
                sta_num);
        }
    }
}   // loadCustomModels

//=============================================================================
// LIGHTNING ARENA - Bitcoin Maxi Extension
//=============================================================================

/** Parse les arguments ligne de commande --lightning-* */
void ThreeStrikesBattle::parseLightningArgs()
{
    m_lightning_server_url = "http://localhost:3000";
    m_lightning_ticket_id = "";
    m_lightning_room_id = "";
    
    // TODO: Lire depuis CommandLine::has("--lightning-server", &s)
    // Pour l'instant, valeurs par défaut
}

/** Convertit PowerupType en string */
std::string ThreeStrikesBattle::powerupTypeToString(int powerup_type)
{
    switch (powerup_type)
    {
        case PowerupManager::POWERUP_BUBBLEGUM: return "bubblegum";
        case PowerupManager::POWERUP_CAKE: return "cake";
        case PowerupManager::POWERUP_BOWLING: return "bowling";
        case PowerupManager::POWERUP_PLUNGER: return "plunger";
        case PowerupManager::POWERUP_SWATTER: return "swatter";
        case PowerupManager::POWERUP_RUBBERBALL: return "rubber_ball";
        case PowerupManager::POWERUP_ANVIL: return "anvil";
        case -2: return "banana";  // Banane = type spécial
        default: return "collision";
    }
}

/** Calcule la récompense selon l'arme */
int ThreeStrikesBattle::calculateReward(const std::string& weapon)
{
    // Économie 1000 sats = 100% vie
    if (weapon == "bowling" || weapon == "anvil")
        return 250;  // Heavy (-25% vie)
    if (weapon == "plunger" || weapon == "swatter" || weapon == "rubber_ball")
        return 100;  // Medium (-10% vie)
    if (weapon == "cake" || weapon == "bubblegum")
        return 50;   // Light (-5% vie)
    if (weapon == "banana")
        return 25;   // Banane au sol (-2.5% vie) - pas d'attaquant
    return 5;        // Collision (-0.5% vie)
}

/** Envoie un hit au serveur Node.js (async) */
void ThreeStrikesBattle::sendHitToServer(int attacker_id, int victim_id, 
                                          const std::string& weapon)
{
    // Pour l'instant, log uniquement. HTTP requiert libcurl configurée.
    Log::info("LightningArena", "Send hit: attacker=%d victim=%d weapon=%s",
              attacker_id, victim_id, weapon.c_str());
    
    // TODO: HTTP POST à /api/hit avec:
    // {
    //   "roomId": m_lightning_room_id,
    //   "attackerTicket": m_lightning_ticket_id,
    //   "victimTicket": "...",
    //   "weapon": weapon
    // }
}

// Note: update() et terminateRace() existent déjà, voir lignes 410 et 551
// Le code Lightning est appelé depuis kartHit() directement

//=============================================================================
// LIGHTNING ARENA - HUD VISUEL (via RaceGUI)
//=============================================================================

/** Affiche un message "+X sats!" (gain) ou "-X sats!" (perte) */
void ThreeStrikesBattle::showSatsPopup(int amount, bool is_gain)
{
    RaceGUIBase* gui = getRaceGUI();
    if (!gui) return;
    
    core::stringw msg;
    if (is_gain)
    {
        // GAIN - Vert
        msg = L"+";
        msg += amount;
        msg += L" sats! [BTC]";
        gui->addMessage(msg, nullptr, 2.0f,
                        video::SColor(255, 0, 255, 0),  // Vert
                        true, true, false);
    }
    else
    {
        // PERTE - Rouge
        msg = L"";
        msg += amount;  // amount est déjà négatif
        msg += L" sats! 💸";
        gui->addMessage(msg, nullptr, 2.0f,
                        video::SColor(255, 255, 0, 0),  // Rouge
                        true, true, false);
    }
    
    // Afficher balance actuelle du joueur local
    AbstractKart* local = getLocalPlayerKart(0);
    if (local)
    {
        int kart_id = local->getWorldKartId();
        if (kart_id >= 0 && kart_id < (int)m_player_sats.size())
        {
            core::stringw balance_msg = L"[BTC] ";
            balance_msg += m_player_sats[kart_id];
            balance_msg += L" sats";
            
            // Orange si positif, rouge si critique
            video::SColor color = (m_player_sats[kart_id] > 20) 
                ? video::SColor(255, 247, 147, 26)  // Orange
                : video::SColor(255, 255, 0, 0);     // Rouge (critique)
            
            gui->addMessage(balance_msg, nullptr, 2.5f, color, false, true, false);
        }
    }
    
    Log::info("LightningArena", "POPUP: %s%d sats", is_gain ? "+" : "", amount);
}

/** Met à jour l'affichage de la balance en temps réel */
void ThreeStrikesBattle::updateLightningHUD(int ticks)
{
    // Afficher la balance en temps réel toutes les 30 frames (0.5s à 60fps)
    static int update_timer = 0;
    update_timer += ticks;
    
    // Écrire la balance dans le fichier toutes les 3 secondes
    // (le HUD est maintenant dessiné par RaceGUI::drawLightningBalance)
    if (update_timer >= 180)
    {
        update_timer = 0;
        
        // === SOLUTION : Écrire la balance dans un fichier ===
        AbstractKart* local = getLocalPlayerKart(0);
        if (local)
        {
            int kart_id = local->getWorldKartId();
            if (kart_id >= 0 && kart_id < (int)m_player_sats.size())
            {
                int balance = m_player_sats[kart_id];
                int lives = m_kart_info[kart_id].m_lives;
                
                // Écrire dans un fichier temporaire
                FILE* f = fopen("C:\\Users\\Silex\\AppData\\Local\\Temp\\lightning_balance.txt", "w");
                if (f)
                {
                    fprintf(f, "=== VOTRE BALANCE ===\n\n");
                    fprintf(f, "  Solde: %d sats\n\n", balance);
                    fprintf(f, "  Vies: %d/3\n\n", lives);
                    
                    if (balance > 50)
                        fprintf(f, "  Status: SAFE\n");
                    else if (balance > 25)
                        fprintf(f, "  Status: RISQUE\n");
                    else
                        fprintf(f, "  Status: DANGER\n");
                    
                    fprintf(f, "\n===========================\n");
                    fclose(f);
                }
            }
        }
    }
}

/** Affiche un message de démarrage avec solde initial */
void ThreeStrikesBattle::initLightningHUD()
{
    RaceGUIBase* gui = getRaceGUI();
    if (!gui) return;
    
    gui->addMessage(_("[ LIGHTNING ARENA ]"), nullptr, 3.0f,
                    video::SColor(255, 247, 147, 26),
                    true, true, false);
    
    gui->addMessage(_("Système P2P - Transferts de sats!"), nullptr, 3.0f,
                    video::SColor(255, 255, 255, 255),
                    false, false, false);
}

/** Affiche la balance avec addMessage - limité à 2x par seconde */
void ThreeStrikesBattle::updateBalanceDisplay()
{
    // OBSOLETE - Le HUD est maintenant dessiné par RaceGUI::drawLightningBalance()
    // pour un affichage propre sans clignotement, avec fond blanc et bords arrondis
}

// LIGHTNING ARENA - Clé secrète pour signer les victoires
// IMPORTANT: En production, utiliser une variable d'environnement ou fichier config
// Cette clé doit correspondre à celle du serveur Node.js
const char* ThreeStrikesBattle::LIGHTNING_SECRET_KEY = "STK_LightningArena_Secret_2024!";

void ThreeStrikesBattle::cleanupLightningHUD()
{
    // Pas besoin - les messages sont gérés par RaceGUI
}

/** LIGHTNING ARENA - Signe la victoire avec HMAC simple pour anti-triche
 *  Utilise un hash combiné (non cryptographique mais suffisant pour anti-triche basique)
 *  \param winner_name Nom du gagnant
 *  \param winner_sats Sats du gagnant
 *  \param timestamp Timestamp de la victoire
 *  \param secret Clé secrète partagée avec le serveur
 *  \return Signature hexadécimale
 */
std::string ThreeStrikesBattle::signVictory(const std::string& winner_name, 
                                            int winner_sats, 
                                            int timestamp,
                                            const std::string& secret)
{
    // Construire le message à signer: winner:sats:timestamp:secret
    std::ostringstream msg;
    msg << winner_name << ":" << winner_sats << ":" << timestamp << ":" << secret;
    std::string message = msg.str();
    
    // Simple hash combiné (FNV-1a + XOR) - suffisant pour anti-triche basique
    // Le serveur Node.js doit implémenter le même algorithme
    unsigned long long hash = 0xcbf29ce484222325ULL; // FNV offset basis
    const unsigned long long prime = 0x100000001b3ULL;
    
    for (size_t i = 0; i < message.length(); i++)
    {
        hash ^= (unsigned char)message[i];
        hash *= prime;
        
        // Ajouter un XOR avec la position pour plus de diffusion
        hash ^= (i * 0x9e3779b97f4a7c15ULL);
        hash = (hash << 13) | (hash >> 51); // Rotation
    }
    
    // Double hash avec le secret à nouveau
    hash ^= 0xdeadbeefcafebabeULL;
    for (size_t i = 0; i < secret.length(); i++)
    {
        hash ^= (unsigned char)secret[i];
        hash *= prime;
    }
    
    // Convertir en hexadécimal (16 chars)
    std::ostringstream hex;
    hex << std::hex << std::setw(16) << std::setfill('0') << hash;
    
    return hex.str();
}   // signVictory

/** LIGHTNING ARENA - Applique un transfert de sats synchronisé depuis le réseau
 *  \param victim_id ID du kart qui perd des sats
 *  \param hitter_id ID du kart qui gagne des sats  
 *  \param amount Montant transféré (peut être partiel si victime ruinée)
 *  \param weapon_type Type d'arme utilisé
 */
void ThreeStrikesBattle::applyNetworkedSatsTransfer(uint8_t victim_id, 
                                                     uint8_t hitter_id,
                                                     int16_t amount, 
                                                     uint8_t weapon_type)
{
    // Vérifier les IDs valides
    if (victim_id >= m_player_sats.size() || hitter_id >= m_player_sats.size())
    {
        Log::warn("LightningArena", "applyNetworkedSatsTransfer: Invalid kart IDs");
        return;
    }
    
    if (victim_id == hitter_id)
    {
        Log::warn("LightningArena", "applyNetworkedSatsTransfer: Self-hit ignored");
        return;
    }

    std::string weapon = powerupTypeToString(weapon_type);
    
    Log::info("LightningArena", "NETWORK TRANSFER: Kart %d → %d | %d sats (%s)",
             victim_id, hitter_id, amount, weapon.c_str());

    // Appliquer le transfert (le serveur a déjà validé)
    m_player_sats[victim_id] -= amount;
    m_player_sats[hitter_id] += amount;
    
    // Afficher popup pour le joueur local
    AbstractKart* local_kart = getLocalPlayerKart(0);
    if (local_kart)
    {
        int local_id = local_kart->getWorldKartId();
        if (local_id == hitter_id)
        {
            showSatsPopup(amount, true);  // Gain
        }
        else if (local_id == victim_id)
        {
            showSatsPopup(-amount, false);  // Perte
        }
    }
    
    // Vérifier élimination
    if (m_player_sats[victim_id] <= 0 && !m_karts[victim_id]->isEliminated())
    {
        Log::info("LightningArena", "☠️ ÉLIMINATION RÉSEAU: Kart %d ruiné!", victim_id);
        
        RaceGUIBase* gui = getRaceGUI();
        if (gui)
        {
            core::stringw elim_msg = m_karts[victim_id]->getName();
            elim_msg += L" est RUINÉ! ☠️";
            gui->addMessage(elim_msg, nullptr, 3.0f,
                           video::SColor(255, 255, 0, 0),
                           true, true, false);
        }
        
        // LIGHTNING ARENA - Mode spectateur si joueur local éliminé (réseau)
        if (local_kart && local_kart->getWorldKartId() == victim_id)
        {
            Camera* cam = Camera::getCamera(0);
            if (cam)
            {
                cam->setMode(Camera::CM_SPECTATOR_TOP_VIEW);
                if (gui)
                {
                    gui->addMessage(_("Mode SPECTATEUR - Appuyez sur 'V' pour changer de vue"),
                                   nullptr, 5.0f,
                                   video::SColor(255, 247, 147, 26),
                                   true, true, false);
                }
                Log::info("LightningArena", "📹 Mode spectateur activé (réseau)");
            }
        }
        
        lightningEliminateKart(victim_id, true);
        m_karts[victim_id]->finishedRace(WorldStatus::getTime());
    }
}   // applyNetworkedSatsTransfer

/** LIGHTNING ARENA - Elimine un kart avec sauvegarde des sats pour reconnexion
 *  \param kart_id ID du kart à éliminer
 *  \param notify_of_elimination Afficher message d'élimination
 */
void ThreeStrikesBattle::lightningEliminateKart(int kart_id, bool notify_of_elimination)
{
    AbstractKart* kart = m_karts[kart_id].get();
    if (kart)
    {
        // Vérifier si ce kart a un ticket assigné (mode en ligne)
        std::string ticket_id;
        for (const auto& pair : m_ticket_to_kart)
        {
            if (pair.second == kart_id)
            {
                ticket_id = pair.first;
                break;
            }
        }
        
        // Si le joueur a un ticket et des sats > 0, sauvegarder pour reconnexion
        if (!ticket_id.empty() && m_player_sats[kart_id] > 0)
        {
            saveDisconnectedPlayer(kart_id, ticket_id);
            Log::info("LightningArena", "💾 Joueur '%s' déconnecté avec %d sats sauvegardés (Ticket: %s)",
                     StringUtils::wideToUtf8(kart->getName()).c_str(),
                     m_player_sats[kart_id], ticket_id.c_str());
            
            // Message pour tous les joueurs
            RaceGUIBase* gui = getRaceGUI();
            if (gui)
            {
                core::stringw msg = kart->getName();
                msg += L" s'est déconnecté. Solde préservé pour reconnexion.";
                gui->addMessage(msg, nullptr, 3.0f,
                               video::SColor(255, 200, 200, 200),
                               true, true, false);
            }
        }
    }
    
    // Appeler la méthode de base
    World::eliminateKart(kart_id, notify_of_elimination);
}   // lightningEliminateKart

/** LIGHTNING ARENA - Sauvegarde le solde d'un joueur qui se déconnecte */
void ThreeStrikesBattle::saveDisconnectedPlayer(int kart_id, const std::string& ticket_id)
{
    DisconnectedPlayer dp;
    dp.kart_id = kart_id;
    dp.sats = m_player_sats[kart_id];
    dp.name = StringUtils::wideToUtf8(m_karts[kart_id]->getName());
    dp.disconnect_time = (uint64_t)time(NULL);
    
    m_disconnected_players[ticket_id] = dp;
    
    // Retirer le mapping actif
    m_ticket_to_kart.erase(ticket_id);
    
    Log::info("LightningArena", "💾 Sauvegarde: Ticket %s -> %d sats", 
             ticket_id.c_str(), dp.sats);
}   // saveDisconnectedPlayer

/** LIGHTNING ARENA - Restaure le solde d'un joueur qui se reconnecte
 *  \param ticket_id Le ticket du joueur
 *  \param new_kart_id Le nouveau kart ID attribué
 *  \return true si restauration réussie
 */
bool ThreeStrikesBattle::restoreReconnectedPlayer(const std::string& ticket_id, int new_kart_id)
{
    auto it = m_disconnected_players.find(ticket_id);
    if (it == m_disconnected_players.end())
    {
        Log::warn("LightningArena", "❌ Ticket inconnu: %s", ticket_id.c_str());
        return false;
    }
    
    DisconnectedPlayer& dp = it->second;
    
    // Vérifier que la partie n'est pas terminée
    if (isRaceOver())
    {
        Log::warn("LightningArena", "⛔ Partie terminée, impossible de restaurer %s", ticket_id.c_str());
        return false;
    }
    
    // Vérifier timeout (7 jours max - pour permettre les parties sur plusieurs jours)
    uint64_t now = (uint64_t)time(NULL);
    const uint64_t MAX_DISCONNECT_TIME = 604800; // 7 jours = 7 * 24 * 60 * 60
    if (now - dp.disconnect_time > MAX_DISCONNECT_TIME)
    {
        Log::warn("LightningArena", "⏱️ Timeout pour %s (déconnecté depuis %d sec)", 
                 ticket_id.c_str(), (int)(now - dp.disconnect_time));
        m_disconnected_players.erase(it);
        return false;
    }
    
    // Restaurer le solde
    if (new_kart_id < (int)m_player_sats.size())
    {
        m_player_sats[new_kart_id] = dp.sats;
    }
    
    // Mettre à jour les mappings
    m_ticket_to_kart[ticket_id] = new_kart_id;
    m_disconnected_players.erase(it);
    
    Log::info("LightningArena", "✅ Restauration: %s -> Kart %d avec %d sats",
             ticket_id.c_str(), new_kart_id, dp.sats);
    
    // Message pour tous
    RaceGUIBase* gui = getRaceGUI();
    if (gui)
    {
        core::stringw msg = L"🎮 ";
        msg += StringUtils::utf8ToWide(dp.name).c_str();
        msg += L" est de retour! Solde: ";
        msg += dp.sats;
        msg += L" sats";
        gui->addMessage(msg, nullptr, 4.0f,
                       video::SColor(255, 0, 255, 0),
                       true, true, false);
    }
    
    return true;
}   // restoreReconnectedPlayer

/** LIGHTNING ARENA - Assigne un ticket à un kart (quand un joueur rejoint) */
void ThreeStrikesBattle::assignTicketToKart(const std::string& ticket_id, int kart_id)
{
    // Vérifier si c'est une reconnexion
    if (m_disconnected_players.find(ticket_id) != m_disconnected_players.end())
    {
        Log::info("LightningArena", "🔄 Reconnexion détectée: %s", ticket_id.c_str());
        restoreReconnectedPlayer(ticket_id, kart_id);
    }
    else
    {
        // Nouveau joueur
        m_ticket_to_kart[ticket_id] = kart_id;
        Log::info("LightningArena", "📝 Nouveau joueur: %s -> Kart %d", 
                 ticket_id.c_str(), kart_id);
    }
}   // assignTicketToKart

/** LIGHTNING ARENA - Nettoie les déconnexions trop anciennes (>7 jours) */
void ThreeStrikesBattle::cleanupOldDisconnections()
{
    uint64_t now = (uint64_t)time(NULL);
    const uint64_t MAX_DISCONNECT_TIME = 604800; // 7 jours = 7 * 24 * 60 * 60
    
    auto it = m_disconnected_players.begin();
    while (it != m_disconnected_players.end())
    {
        if (now - it->second.disconnect_time > MAX_DISCONNECT_TIME)
        {
            Log::info("LightningArena", "🗑️ Cleanup: Suppression de %s (timeout)", 
                     it->first.c_str());
            it = m_disconnected_players.erase(it);
        }
        else
        {
            ++it;
        }
    }
}   // cleanupOldDisconnections
