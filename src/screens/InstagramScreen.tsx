import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import apiService from '../services/api';
import CustomToast from '../components/CustomToast';
import { RootStackParamList } from '../../App';

type NavigationProp = NativeStackNavigationProp<RootStackParamList>;

const InstagramScreen = () => {
  const navigation = useNavigation<NavigationProp>();
  const [instagramCreds, setInstagramCreds] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [toast, setToast] = useState({ visible: false, message: '', type: 'success' as 'success' | 'error' | 'warning' | 'info' });

  useEffect(() => {
    loadCredentials();
  }, []);

  const loadCredentials = async () => {
    try {
      const instagram = await apiService.getInstagramCredentials();
      setInstagramCreds(instagram);
      // Only set username if Instagram is actually configured
      if (instagram?.configured && instagram?.username) {
        setUsername(instagram.username);
      } else {
        setUsername('');
      }
    } catch (e) {
      console.error('Error loading Instagram credentials:', e);
      setInstagramCreds({ configured: false, username: null });
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    const hasSessionId = sessionId.trim().length > 0;
    const hasUserPass = username.trim().length > 0 && password.trim().length > 0;

    if (!hasSessionId && !hasUserPass) {
      setToast({ visible: true, message: 'Please enter (Username & Password) OR a Session ID', type: 'warning' });
      return;
    }
    
    try {
      setSaving(true);
      await apiService.setInstagramCredentials(
        username.trim() || 'session_user', 
        password.trim() ? password.trim() : undefined,
        sessionId.trim() ? sessionId.trim() : undefined
      );
      await loadCredentials();
      setPassword('');
      setSessionId('');
      setToast({ visible: true, message: 'Verified & credentials saved!', type: 'success' });
    } catch (error: any) {
      const errorMsg = error?.response?.data?.detail || 'Failed to save credentials';
      setToast({ visible: true, message: errorMsg, type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => {
    setShowDeleteModal(true);
  };

  const confirmDelete = async () => {
    try {
      setShowDeleteModal(false);
      await apiService.deleteInstagramCredentials();
      setInstagramCreds({ configured: false, username: null });
      setUsername('');
      setPassword('');
      setSessionId('');
      setToast({ visible: true, message: 'Credentials removed', type: 'success' });
    } catch {
      setToast({ visible: true, message: 'Failed to remove credentials', type: 'error' });
    }
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Instagram</Text>
        </View>

        <Text style={styles.description}>
          Configure your Instagram account to download and analyze posts.
        </Text>

        <View style={styles.statusCard}>
          <View style={styles.statusRow}>
            <Ionicons 
              name={instagramCreds?.configured ? 'checkmark-circle' : 'close-circle'} 
              size={24} 
              color={instagramCreds?.configured ? '#28a745' : '#dc3545'} 
            />
            <Text style={styles.statusText}>
              {instagramCreds?.configured && instagramCreds?.username
                ? `Connected as @${instagramCreds.username}`
                : 'Not configured'
              }
            </Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Account Credentials</Text>
          
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Username</Text>
            <TextInput
              style={styles.textInput}
              value={username}
              onChangeText={setUsername}
              placeholder="Instagram username"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Password</Text>
            <TextInput
              style={styles.textInput}
              value={password}
              onChangeText={setPassword}
              placeholder="Instagram password"
              placeholderTextColor={colors.textMuted}
              secureTextEntry
            />
          </View>
          
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Session ID Cookie</Text>
            <TextInput
              style={styles.textInput}
              value={sessionId}
              onChangeText={setSessionId}
              placeholder="sessionid"
              placeholderTextColor={colors.textMuted}
              secureTextEntry
            />
            <Text style={{ fontSize: 13, color: colors.textMuted, marginTop: 4 }}>
              If a session ID is used, username and password are not required.
            </Text>
          </View>
          
          <TouchableOpacity
            style={[styles.saveButton, saving && { opacity: 0.7 }]}
            onPress={handleSave}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.saveButtonText}>Save Credentials</Text>
            )}
          </TouchableOpacity>
          
          {instagramCreds?.configured && (
            <TouchableOpacity
              style={[styles.dangerButton, { marginTop: 16 }]}
              onPress={handleDelete}
            >
              <Ionicons name="trash" size={18} color="#fff" />
              <Text style={styles.dangerButtonText}>Remove Credentials</Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={styles.infoCard}>
          <Text style={styles.infoTitle}>Important</Text>
          <Text style={styles.infoText}>
            • Burner account for scarping{'\n'}
            • Don't use your main personal account{'\n'}
            • Session is cached after first login{'\n'}
            • Your credentials are stored securely
          </Text>
        </View>
      </ScrollView>
      <Modal
        visible={showDeleteModal}
        animationType="fade"
        transparent={true}
        onRequestClose={() => setShowDeleteModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.deleteModalContent}>
            <View style={styles.deleteIconContainer}>
              <Ionicons name="trash" size={40} color={colors.error} />
            </View>
            <Text style={styles.deleteTitle}>Remove Credentials?</Text>
            <Text style={styles.deleteMessage}>
              Are you sure you want to remove Instagram credentials? This action cannot be undone.
            </Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={styles.modalButtonCancel}
                onPress={() => setShowDeleteModal(false)}
              >
                <Text style={styles.modalButtonCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalButtonDelete}
                onPress={confirmDelete}
              >
                <Text style={styles.modalButtonDeleteText}>Remove</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
      <CustomToast
        visible={toast.visible}
        message={toast.message}
        type={toast.type}
        onHide={() => setToast({ ...toast, visible: false })}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: 'center',
    alignItems: 'center',
  },
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 60,
    paddingBottom: 20,
  },
  backButton: {
    padding: 8,
    marginRight: 8,
    marginLeft: -14,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.text,
  },
  content: {
    paddingHorizontal: 20,
    paddingBottom: 40,
  },
  description: {
    fontSize: 14,
    color: colors.textSecondary,
    marginBottom: 24,
    lineHeight: 20,
  },
  statusCard: {
    backgroundColor: colors.backgroundCard,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 24,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  statusText: {
    fontSize: 16,
    fontWeight: '500',
    color: colors.text,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 16,
  },
  inputGroup: {
    marginBottom: 16,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.text,
    marginBottom: 8,
  },
  textInput: {
    backgroundColor: colors.backgroundCard,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: colors.text,
  },
  saveButton: {
    backgroundColor: colors.primary,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  saveButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  dangerButton: {
    backgroundColor: '#dc3545',
    paddingVertical: 14,
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  dangerButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  infoCard: {
    backgroundColor: colors.backgroundCard,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  infoTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 8,
  },
  infoText: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 22,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'center',
  },
  deleteModalContent: {
    backgroundColor: colors.background,
    borderRadius: 24,
    padding: 24,
    marginHorizontal: 20,
    alignItems: 'center',
  },
  deleteIconContainer: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: colors.backgroundCard,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
  },
  deleteTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 12,
  },
  deleteMessage: {
    fontSize: 15,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  modalButtonCancel: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: colors.backgroundCard,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  modalButtonCancelText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  modalButtonDelete: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: colors.error,
    alignItems: 'center',
  },
  modalButtonDeleteText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
});

export default InstagramScreen;
