//
//  SuperTuxKart - a fun racing game with go-kart
//  Copyright (C) 2004-2015 SuperTuxKart-Team
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

#ifndef THREE_STRIKES_BATTLE_HPP
#define THREE_STRIKES_BATTLE_HPP


#include "modes/world_with_rank.hpp"
#include "tracks/track_object.hpp"
#include "states_screens/race_gui_base.hpp"

#include <IMesh.h>

#include <string>

class PhysicalObject;

/**
 *  \brief An implementation of WorldWithRank, to provide the 3 strikes battle
 *  game mode
 * \ingroup modes
 */
class ThreeStrikesBattle : public WorldWithRank
{
private:

    // This struct is used to sort karts by time/lives
    struct KartValues
    {
        int id;
        int time;
        int lives;

        bool operator < (const KartValues& k) const
        {
            return (time == k.time) ? (lives < k.lives) : (time < k.time);
        }   // operator <
    }; // KartValues

    struct BattleInfo
    {
        int  m_lives;
    };

    /** This vector contains an 'BattleInfo' struct for every kart in the race.
    */
    std::vector<BattleInfo> m_kart_info;

    /** The mesh of the tire which is displayed when a kart loses a life. */
    irr::scene::IMesh* m_tire;

    /** Indicates the number of tires that should be
     *  inserted into the track. */
    int m_insert_tire;

    /** For tires that are blown away. */
    core::vector3df m_tire_position;

    /** The original locations of the tires of a kart. */
    core::vector3df m_tire_offsets[4];

    /** The radius of the karts original tires. */
    float m_tire_radius[4];

    /** The directory of the original kart tires. */
    std::string m_tire_dir;

    /** A rotation to apply to the tires when inserting them. */
    float m_tire_rotation;

    PtrVector<TrackObject, REF> m_tires;

    /** Profiling usage */
    int m_total_rescue;
    int m_frame_count;
    int m_start_time;
    int m_total_hit;

    std::vector<AbstractKart*> m_spare_tire_karts;
    int m_next_sta_spawn_ticks;

public:
    /** Used to show a nice graph when battle is over */
    struct BattleEvent
    {
        float m_time;
        std::vector<BattleInfo> m_kart_info;
    };
    // ------------------------------------------------------------------------
    std::vector<BattleEvent> m_battle_events;
    // ------------------------------------------------------------------------
    ThreeStrikesBattle();
    // ------------------------------------------------------------------------
    virtual ~ThreeStrikesBattle();
    // ------------------------------------------------------------------------
    virtual void init() OVERRIDE;
    // ------------------------------------------------------------------------
    // clock events
    virtual bool isRaceOver() OVERRIDE;
    // ------------------------------------------------------------------------
    virtual void terminateRace() OVERRIDE;
    // ------------------------------------------------------------------------
    // overriding World methods
    virtual void reset(bool restart=false) OVERRIDE;
    // ------------------------------------------------------------------------
    virtual void getKartsDisplayInfo(
                 std::vector<RaceGUIBase::KartIconDisplayInfo> *info) OVERRIDE;
    // ------------------------------------------------------------------------
    virtual bool raceHasLaps() OVERRIDE                       { return false; }
    // ------------------------------------------------------------------------
    virtual const std::string& getIdent() const OVERRIDE;
    // ------------------------------------------------------------------------
    virtual bool kartHit(int kart_id, int hitter = -1, int weapon_type = -1) OVERRIDE;
    // ------------------------------------------------------------------------
    // LIGHTNING ARENA - Bitcoin Maxi Extension
    // ------------------------------------------------------------------------
private:
    /** URL du serveur Node.js (ex: http://localhost:3000) */
    std::string m_lightning_server_url;
    
    /** Ticket ID du joueur */
    std::string m_lightning_ticket_id;
    
    /** Room ID pour le matchmaking */
    std::string m_lightning_room_id;
    
    /** Balance en sats de chaque joueur (système P2P) */
    std::vector<int> m_player_sats;
    
    /** Solde initial par joueur (1000 sats = 100% vie) */
    static const int STARTING_SATS = 1000;
    
    /** Total des hits donnés */
    int m_total_hits_given;
    
    /** LIGHTNING ARENA - Tickets des joueurs déconnectés avec leur solde persistant */
    struct DisconnectedPlayer {
        int kart_id;           // ID original du kart
        int sats;              // Solde à la déconnexion
        std::string name;      // Nom du joueur
        uint64_t disconnect_time; // Timestamp de déconnexion
    };
    std::map<std::string, DisconnectedPlayer> m_disconnected_players;
    
    /** LIGHTNING ARENA - Mapping ticket_id -> kart_id pour les joueurs actifs */
    std::map<std::string, int> m_ticket_to_kart;
    
    /** Envoie un hit au serveur Node.js */
    void sendHitToServer(int attacker_id, int victim_id, const std::string& weapon);
    
protected:
    // LIGHTNING ARENA - Accessible aux classes dérivées
    /** Calcule la récompense selon l'arme */
    int calculateReward(const std::string& weapon);
    
    /** Convertit PowerupType en string */
    std::string powerupTypeToString(int powerup_type);
    
private:
    /** Lit les arguments ligne de commande --lightning-* */
    void parseLightningArgs();
    
    // LIGHTNING ARENA - HUD visuel
    void showSatsPopup(int amount, bool is_gain = true);
    void initLightningHUD();
    void updateBalanceDisplay();
    void updateLightningHUD(int ticks);
    void cleanupLightningHUD();
    
public:
    // ------------------------------------------------------------------------
    virtual void update(int ticks) OVERRIDE;
    // ------------------------------------------------------------------------
    virtual void updateGraphics(float dt) OVERRIDE;
    // ------------------------------------------------------------------------
    virtual void kartAdded(AbstractKart* kart, scene::ISceneNode* node)
                                                                      OVERRIDE;
    // ------------------------------------------------------------------------
    virtual void enterRaceOverState() OVERRIDE;
    // ------------------------------------------------------------------------
    virtual void loadCustomModels() OVERRIDE;
    // ------------------------------------------------------------------------
    void updateKartRanks();
    // ------------------------------------------------------------------------
    void increaseRescueCount()                            { m_total_rescue++; }
    // ------------------------------------------------------------------------
    void addKartLife(unsigned int id);
    // ------------------------------------------------------------------------
    int getKartLife(unsigned int id) const  { return m_kart_info[id].m_lives; }
    // ------------------------------------------------------------------------
    int getPlayerSats(int kart_id) const { 
        if (kart_id >= 0 && kart_id < (int)m_player_sats.size()) 
            return m_player_sats[kart_id]; 
        return 0; 
    }
    // ------------------------------------------------------------------------
    /** LIGHTNING ARENA - Apply a networked sats transfer (called from GameEventsProtocol) */
    void applyNetworkedSatsTransfer(uint8_t victim_id, uint8_t hitter_id, 
                                    int16_t amount, uint8_t weapon_type);
    // ------------------------------------------------------------------------
    /** LIGHTNING ARENA - Signe la victoire avec HMAC pour anti-triche */
    std::string signVictory(const std::string& winner_name, int winner_sats, 
                            int timestamp, const std::string& secret);
    // ------------------------------------------------------------------------
    /** LIGHTNING ARENA - Clé secrète pour signer les victoires (à changer en prod!) */
    static const char* LIGHTNING_SECRET_KEY;
    // ------------------------------------------------------------------------
    bool spareTireKartsSpawned() const;
    // ------------------------------------------------------------------------
    void spawnSpareTireKarts();
    // ------------------------------------------------------------------------
    /** LIGHTNING ARENA - Elimine un kart avec sauvegarde des sats pour reconnexion
     *  Utiliser cette méthode au lieu de World::eliminateKart() dans ThreeStrikesBattle
     */
    void lightningEliminateKart(int kart_id, bool notify_of_elimination = true);
    // ------------------------------------------------------------------------
    /** LIGHTNING ARENA - Sauvegarde le solde d'un joueur qui se déconnecte */
    void saveDisconnectedPlayer(int kart_id, const std::string& ticket_id);
    // ------------------------------------------------------------------------
    /** LIGHTNING ARENA - Restaure le solde d'un joueur qui se reconnecte */
    bool restoreReconnectedPlayer(const std::string& ticket_id, int new_kart_id);
    // ------------------------------------------------------------------------
    /** LIGHTNING ARENA - Assigne un ticket à un kart */
    void assignTicketToKart(const std::string& ticket_id, int kart_id);
    // ------------------------------------------------------------------------
    /** LIGHTNING ARENA - Nettoie les déconnexions trop anciennes (>5 min) */
    void cleanupOldDisconnections();

};   // ThreeStrikesBattles


#endif
