import React, { useState, useEffect, useMemo } from 'react';
import { 
  Calendar as CalendarIcon, 
  Plus, 
  Trash2, 
  AlertCircle, 
  Utensils,
  X,
  CheckCircle2,
  Sparkles,
  Package,
  Edit3,
  Loader2,
  Share2,
  LogIn,
  LogOut,
  Users,
  Copy
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI, Type } from "@google/genai";
import { 
  collection, 
  doc, 
  onSnapshot, 
  setDoc, 
  deleteDoc, 
  query, 
  where,
  getDoc,
  updateDoc,
  arrayUnion,
  serverTimestamp,
  writeBatch,
  getDocFromServer
} from 'firebase/firestore';
import { onAuthStateChanged, User } from 'firebase/auth';
import { db, auth, signInWithGoogle, logout } from './firebase';
import { MealEntry, MealType } from './types';
import { PREFILLED_MEALS } from './prefilledData';

// --- Utils ---

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

const handleFirestoreError = (error: unknown, operationType: OperationType, path: string | null) => {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  // We don't throw here to avoid crashing the UI, but we log it for the system to see
  return errInfo;
};

const getDaysArray = (days: number) => {
  const arr = [];
  const today = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    arr.push(d.toISOString().split('T')[0]);
  }
  return arr;
};

const formatDate = (dateStr: string) => {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { 
    weekday: 'short', 
    month: 'short', 
    day: 'numeric' 
  });
};

// --- Main Component ---

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [householdId, setHouseholdId] = useState<string | null>(localStorage.getItem('meal-planner-household-id'));
  const [householdName, setHouseholdName] = useState<string | null>(null);
  
  const [meals, setMeals] = useState<MealEntry[]>([]);
  const [pantry, setPantry] = useState<string[]>(() => {
    const saved = localStorage.getItem('meal-planner-pantry');
    return saved ? JSON.parse(saved) : ['Soy Sauce', 'Coconut Milk', 'Rice Vinegar', 'Garlic', 'Onions', 'Vinegars'];
  });

  const [newMealName, setNewMealName] = useState('');
  const [newPantryItem, setNewPantryItem] = useState('');
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [selectedType, setSelectedType] = useState<MealType>('dinner');
  const [warning, setWarning] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [aiSuggestions, setAiSuggestions] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const [isCreatingHousehold, setIsCreatingHousehold] = useState(false);
  const [householdNameInput, setHouseholdNameInput] = useState('');
  const [showHouseholdModal, setShowHouseholdModal] = useState<'create' | 'join' | null>(null);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');

  const days = useMemo(() => getDaysArray(60), []);
  const ai = useMemo(() => new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }), []);

  // Connection Test
  useEffect(() => {
    async function testConnection() {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if (error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration. The client is offline.");
        }
      }
    }
    testConnection();
  }, []);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Handle Invitation Link
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const joinId = params.get('join');
    
    if (joinId) {
      if (!user && !isLoading) {
        setWarning("Please login to join the shared household.");
      } else if (user && !householdId) {
        const joinFromLink = async () => {
          try {
            const hDoc = await getDoc(doc(db, 'households', joinId));
            if (hDoc.exists()) {
              // Check if already a member to avoid redundant updates
              const data = hDoc.data();
              if (!data.members.includes(user.uid)) {
                await updateDoc(doc(db, 'households', joinId), {
                  members: arrayUnion(user.uid)
                });
              }
              setHouseholdId(joinId);
              localStorage.setItem('meal-planner-household-id', joinId);
              setSuccess(`Successfully joined ${data.name}!`);
              // Clear URL param
              window.history.replaceState({}, document.title, window.location.pathname);
            } else {
              setWarning("Invitation link is invalid or household no longer exists.");
            }
          } catch (error) {
            console.error("Error joining from link:", error);
            setWarning("Failed to join household. Check your connection.");
          }
        };
        joinFromLink();
      }
    }
  }, [user, householdId, isLoading]);

  // Household Listener
  useEffect(() => {
    if (!householdId) return;
    
    const unsubscribe = onSnapshot(doc(db, 'households', householdId), (snapshot) => {
      if (snapshot.exists()) {
        setHouseholdName(snapshot.data().name);
      } else {
        setHouseholdId(null);
        localStorage.removeItem('meal-planner-household-id');
      }
    });
    return () => unsubscribe();
  }, [householdId]);

  // Meals Listener (Real-time Sync)
  useEffect(() => {
    if (!householdId) {
      // Fallback to local storage or prefilled data if not in a household
      const saved = localStorage.getItem('meal-planner-local-meals');
      if (saved) {
        try {
          setMeals(JSON.parse(saved));
        } catch (e) {
          setMeals(PREFILLED_MEALS);
        }
      } else {
        setMeals(PREFILLED_MEALS);
      }
      setIsLoading(false);
      return;
    }

    const q = collection(db, 'households', householdId, 'meals');
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const mealData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as MealEntry[];
      setMeals(mealData);
    });

    return () => unsubscribe();
  }, [householdId]);

  // Sync Pantry with localStorage
  useEffect(() => {
    localStorage.setItem('meal-planner-pantry', JSON.stringify(pantry));
  }, [pantry]);

  const handleCreateHousehold = async () => {
    if (!user || !householdNameInput.trim()) return;
    const name = householdNameInput.trim();

    setIsCreatingHousehold(true);
    try {
      const newHouseholdRef = doc(collection(db, 'households'));
      const newId = newHouseholdRef.id;

      await setDoc(newHouseholdRef, {
        name,
        ownerId: user.uid,
        members: [user.uid]
      });

      setHouseholdId(newId);
      localStorage.setItem('meal-planner-household-id', newId);
      
      // Seed with prefilled data using batches (max 500 per batch)
      const batch = writeBatch(db);
      PREFILLED_MEALS.forEach((meal) => {
        const mealRef = doc(db, 'households', newId, 'meals', meal.id);
        batch.set(mealRef, {
          ...meal,
          updatedBy: user.uid,
          updatedAt: new Date().toISOString()
        });
      });
      
      await batch.commit();
      setSuccess("Household created and data synced!");
      setShowHouseholdModal(null);
      setHouseholdNameInput('');
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'households');
      setWarning("Failed to create household. Check your connection.");
    } finally {
      setIsCreatingHousehold(false);
    }
  };

  const handleJoinHousehold = async () => {
    if (!user || !householdNameInput.trim()) return;
    const id = householdNameInput.trim();

    setIsCreatingHousehold(true);
    try {
      const hDoc = await getDoc(doc(db, 'households', id));
      if (hDoc.exists()) {
        await updateDoc(doc(db, 'households', id), {
          members: arrayUnion(user.uid)
        });
        setHouseholdId(id);
        localStorage.setItem('meal-planner-household-id', id);
        setSuccess("Joined household successfully!");
        setShowHouseholdModal(null);
        setHouseholdNameInput('');
      } else {
        setWarning("Household not found.");
      }
    } catch (error) {
      console.error("Error joining household:", error);
      setWarning("Failed to join household. Check the ID.");
    } finally {
      setIsCreatingHousehold(false);
    }
  };

  const [draggedMeal, setDraggedMeal] = useState<{id: string, name: string} | null>(null);

  const onDragStart = (e: React.DragEvent, meal: MealEntry) => {
    setDraggedMeal({ id: meal.id, name: meal.name });
    e.dataTransfer.setData('mealId', meal.id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const onDrop = async (e: React.DragEvent, targetDate: string, targetType: MealType) => {
    e.preventDefault();
    const mealId = e.dataTransfer.getData('mealId');
    const meal = meals.find(m => m.id === mealId);
    
    if (!meal) return;
    if (meal.date === targetDate && meal.type === targetType) return;

    // Check if target already has a meal
    const existingAtTarget = meals.find(m => m.date === targetDate && m.type === targetType);
    
    if (validateMeal(meal.name, targetDate, targetType, meal.id)) {
      if (!householdId || !user) {
        // Local mode
        let updatedMeals = meals.filter(m => m.id !== meal.id);
        if (existingAtTarget) {
          updatedMeals = updatedMeals.filter(m => m.id !== existingAtTarget.id);
        }
        updatedMeals.push({ ...meal, date: targetDate, type: targetType, id: `${targetDate}_${targetType}` });
        setMeals(updatedMeals);
        localStorage.setItem('meal-planner-local-meals', JSON.stringify(updatedMeals));
      } else {
        // Shared mode
        try {
          const batch = writeBatch(db);
          // Delete old
          batch.delete(doc(db, 'households', householdId, 'meals', meal.id));
          // Set new
          const newId = `${targetDate}_${targetType}`;
          batch.set(doc(db, 'households', householdId, 'meals', newId), {
            date: targetDate,
            type: targetType,
            name: meal.name,
            updatedBy: user.uid,
            updatedAt: new Date().toISOString()
          });
          await batch.commit();
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, `households/${householdId}/meals`);
        }
      }
    }
    setDraggedMeal(null);
  };

  const getAiSuggestions = async () => {
    if (pantry.length === 0) return;
    setIsGenerating(true);
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Based on these pantry items: ${pantry.join(', ')}, suggest 3 simple meal names. Return ONLY a JSON array of strings.`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: { type: Type.STRING }
          }
        }
      });
      const suggestions = JSON.parse(response.text);
      setAiSuggestions(suggestions);
    } catch (error) {
      console.error("AI Error:", error);
    } finally {
      setIsGenerating(false);
    }
  };

  const getViolation = (meal: MealEntry) => {
    const targetDate = new Date(meal.date);
    const normalizedName = meal.name.trim().toLowerCase();
    if (!normalizedName) return null;

    return meals.find(m => {
      if (m.id === meal.id) return false;
      if (m.name.toLowerCase() !== normalizedName) return false;
      
      const mDate = new Date(m.date);
      const diffTime = targetDate.getTime() - mDate.getTime();
      const diffDays = Math.round(Math.abs(diffTime) / (1000 * 60 * 60 * 24));
      
      if (diffDays >= 14) return false;

      // Leftover Exception:
      // If current is lunch and conflict was dinner on the PREVIOUS day, it's a leftover.
      const isCurrentLunch = meal.type === 'lunch';
      const isConflictDinner = m.type === 'dinner';
      const isNextDay = diffTime === (1000 * 60 * 60 * 24); // Exactly 1 day later
      
      if (isCurrentLunch && isConflictDinner && isNextDay) {
        return false;
      }

      // Reverse Leftover Exception (if we are looking at the dinner and the lunch is already planned)
      const isCurrentDinner = meal.type === 'dinner';
      const isConflictLunch = m.type === 'lunch';
      const isPrevDay = diffTime === -(1000 * 60 * 60 * 24); // Exactly 1 day earlier

      if (isCurrentDinner && isConflictLunch && isPrevDay) {
        return false;
      }

      return true;
    });
  };

  const validateMeal = (name: string, date: string, type: MealType, currentId?: string) => {
    const normalizedName = name.trim().toLowerCase();
    if (!normalizedName) return true;

    const tempMeal: MealEntry = {
      id: currentId || 'temp',
      name,
      date,
      type
    };

    const conflict = getViolation(tempMeal);

    if (conflict) {
      const conflictDate = formatDate(conflict.date);
      setWarning(`Warning: "${name}" was planned on ${conflictDate} (${conflict.type}). Please wait 14 days between repeats.`);
      return false;
    }

    setWarning(null);
    return true;
  };

  const handleAddMeal = async (e?: React.FormEvent, nameOverride?: string) => {
    if (e) e.preventDefault();
    const name = nameOverride || newMealName;
    if (!name.trim()) return;

    if (validateMeal(name, selectedDate, selectedType)) {
      if (!householdId || !user) {
        // Local only if not logged in/no household
        const id = `${selectedDate}_${selectedType}`;
        const existingMealIndex = meals.findIndex(m => m.id === id || (m.date === selectedDate && m.type === selectedType));
        
        let updatedMeals;
        if (existingMealIndex > -1) {
          updatedMeals = [...meals];
          updatedMeals[existingMealIndex] = { id, date: selectedDate, type: selectedType, name: name.trim() };
        } else {
          updatedMeals = [...meals, { id, date: selectedDate, type: selectedType, name: name.trim() }];
        }
        
        setMeals(updatedMeals);
        localStorage.setItem('meal-planner-local-meals', JSON.stringify(updatedMeals));
        setSuccess(`Planned ${selectedType} "${name}" (Local only)`);
      } else {
        const mealId = `${selectedDate}_${selectedType}`;
        try {
          await setDoc(doc(db, 'households', householdId, 'meals', mealId), {
            date: selectedDate,
            type: selectedType,
            name: name.trim(),
            updatedBy: user.uid,
            updatedAt: new Date().toISOString()
          });
          setSuccess(`Planned ${selectedType} "${name}"`);
        } catch (error) {
          console.error("Error saving meal:", error);
          alert("Failed to save meal. Check security rules.");
        }
      }
      
      if (!nameOverride) setNewMealName('');
      setTimeout(() => setSuccess(null), 3000);
    }
  };

  const handleInlineEdit = async (date: string, type: MealType, newName: string) => {
    if (!householdId || !user) {
      // Local mode inline edit
      const existingMeal = meals.find(m => m.date === date && m.type === type);
      
      if (!newName) {
        if (existingMeal) {
          const updatedMeals = meals.filter(m => m.id !== existingMeal.id);
          setMeals(updatedMeals);
          localStorage.setItem('meal-planner-local-meals', JSON.stringify(updatedMeals));
        }
        return;
      }

      if (validateMeal(newName, date, type, existingMeal?.id)) {
        let updatedMeals;
        if (existingMeal) {
          updatedMeals = meals.map(m => m.id === existingMeal.id ? { ...m, name: newName } : m);
        } else {
          updatedMeals = [...meals, { id: `${date}_${type}`, date, type, name: newName }];
        }
        setMeals(updatedMeals);
        localStorage.setItem('meal-planner-local-meals', JSON.stringify(updatedMeals));
      }
      return;
    }
    
    const mealId = `${date}_${type}`;
    if (!newName) {
      try {
        await deleteDoc(doc(db, 'households', householdId, 'meals', mealId));
      } catch (error) {
        handleFirestoreError(error, OperationType.DELETE, `households/${householdId}/meals/${mealId}`);
      }
      return;
    }

    if (validateMeal(newName, date, type, mealId)) {
      try {
        await setDoc(doc(db, 'households', householdId, 'meals', mealId), {
          date,
          type,
          name: newName, // Allow spaces while typing
          updatedBy: user.uid,
          updatedAt: new Date().toISOString()
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, `households/${householdId}/meals/${mealId}`);
      }
    }
  };

  const handleRemoveMeal = async (id: string) => {
    if (!householdId || !user) {
      const updatedMeals = meals.filter(m => m.id !== id);
      setMeals(updatedMeals);
      localStorage.setItem('meal-planner-local-meals', JSON.stringify(updatedMeals));
    } else {
      try {
        await deleteDoc(doc(db, 'households', householdId, 'meals', id));
      } catch (error) {
        handleFirestoreError(error, OperationType.DELETE, `households/${householdId}/meals/${id}`);
      }
    }
  };

  const handleAddPantry = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPantryItem.trim()) return;
    if (!pantry.includes(newPantryItem.trim())) {
      setPantry([...pantry, newPantryItem.trim()]);
    }
    setNewPantryItem('');
  };

  const handleRemovePantry = (item: string) => {
    setPantry(pantry.filter(i => i !== item));
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="animate-spin text-emerald-500" size={48} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F9FAFB] text-[#111827] font-sans p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <header className="mb-12 flex flex-col md:flex-row md:items-start justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 text-emerald-600 mb-2">
              <Utensils size={24} />
              <span className="text-xs font-bold uppercase tracking-widest">Kitchen Companion</span>
            </div>
            <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight text-slate-900">
              Meal Planner
            </h1>
            <p className="text-slate-500 mt-2 max-w-md">
              Shared nutrition planning for you and your partner.
            </p>
          </div>
          
          <div className="flex flex-col items-end gap-3">
            {user ? (
              <div className="flex items-center gap-4 bg-white p-2 pl-4 rounded-2xl border border-slate-100 shadow-sm">
                <div className="text-right">
                  <div className="text-sm font-bold text-slate-900">{user.displayName}</div>
                  <div className="text-[10px] text-slate-400 font-medium">{user.email}</div>
                </div>
                <button 
                  onClick={logout}
                  className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all"
                  title="Logout"
                >
                  <LogOut size={20} />
                </button>
              </div>
            ) : (
              <button 
                onClick={signInWithGoogle}
                className="flex items-center gap-2 px-6 py-3 bg-white text-slate-900 font-bold rounded-2xl border border-slate-200 hover:border-emerald-500 transition-all shadow-sm"
              >
                <LogIn size={20} className="text-emerald-500" />
                Login to Share
              </button>
            )}
          </div>
        </header>

        {/* Collaboration Banner */}
        {user && (
          <div className="mb-8 bg-emerald-900 text-white p-6 rounded-3xl shadow-xl flex flex-col md:flex-row items-center justify-between gap-6 overflow-hidden relative">
            <div className="relative z-10">
              {householdId ? (
                <>
                  <h3 className="text-xl font-bold flex items-center gap-2">
                    <Users size={24} />
                    {householdName || 'My Household'}
                  </h3>
                  <p className="text-emerald-200 text-sm mt-1">Sharing is active. Your partner can now edit in real-time.</p>
                </>
              ) : (
                <>
                  <h3 className="text-xl font-bold">Start Collaborating</h3>
                  <p className="text-emerald-200 text-sm mt-1">Create a household to share your plan with your partner.</p>
                </>
              )}
            </div>
            
            <div className="flex flex-wrap gap-3 relative z-10">
              {householdId ? (
                <div className="flex flex-col gap-2 w-full md:w-auto">
                  <div className="flex flex-wrap gap-3">
                    <button 
                      onClick={() => setShowInviteForm(!showInviteForm)}
                      className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-xl text-sm font-bold transition-all border border-emerald-500 shadow-lg"
                    >
                      <Share2 size={16} />
                      {showInviteForm ? 'Cancel' : 'Invite Partner'}
                    </button>
                  </div>
                  
                  {showInviteForm && (
                    <motion.div 
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="mt-2 p-3 bg-white/10 rounded-xl border border-white/20 flex flex-col gap-2"
                    >
                      <p className="text-[10px] uppercase font-bold text-emerald-200">Enter partner's email:</p>
                      <div className="flex gap-2">
                        <input 
                          type="email"
                          placeholder="partner@example.com"
                          value={inviteEmail}
                          onChange={(e) => setInviteEmail(e.target.value)}
                          className="flex-1 bg-black/20 border border-white/10 rounded-lg px-3 py-1 text-xs outline-none focus:border-emerald-500 transition-colors"
                        />
                        <button 
                          onClick={() => {
                            if (!inviteEmail || !inviteEmail.includes('@')) {
                              setWarning("Please enter a valid email address.");
                              setTimeout(() => setWarning(null), 3000);
                              return;
                            }
                            const inviteUrl = `${window.location.origin}${window.location.pathname}?join=${householdId}`;
                            const subject = encodeURIComponent(`Join my Meal Planner kitchen: ${householdName || 'Our Home'}`);
                            const body = encodeURIComponent(`Hi!\n\nI'd like to share my meal plan with you so we can collaborate in real-time. \n\nClick here to join our household: ${inviteUrl}\n\nSee you there!`);
                            window.location.href = `mailto:${inviteEmail}?subject=${subject}&body=${body}`;
                            setSuccess("Opening your email client...");
                            setTimeout(() => setSuccess(null), 3000);
                            setShowInviteForm(false);
                            setInviteEmail('');
                          }}
                          className="px-3 py-1 bg-emerald-500 hover:bg-emerald-400 rounded-lg text-[10px] font-bold transition-colors"
                        >
                          Send
                        </button>
                      </div>
                    </motion.div>
                  )}
                </div>
              ) : (
                <>
                  <button 
                    onClick={() => setShowHouseholdModal('create')}
                    disabled={isCreatingHousehold}
                    className="px-6 py-2 bg-white text-emerald-900 rounded-xl text-sm font-bold hover:bg-emerald-50 transition-all shadow-lg disabled:opacity-50 flex items-center gap-2"
                  >
                    Create New
                  </button>
                  <button 
                    onClick={() => setShowHouseholdModal('join')}
                    disabled={isCreatingHousehold}
                    className="px-6 py-2 bg-emerald-800 text-white rounded-xl text-sm font-bold hover:bg-emerald-700 transition-all border border-emerald-700 disabled:opacity-50"
                  >
                    Join Existing
                  </button>
                </>
              )}
            </div>
            
            <Utensils className="absolute -right-8 -bottom-8 text-white/5 w-48 h-48 rotate-12" />
          </div>
        )}

        {/* Household Modal */}
        <AnimatePresence>
          {showHouseholdModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
              <motion.div 
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className="bg-white rounded-3xl p-8 max-w-md w-full shadow-2xl"
              >
                <div className="flex justify-between items-center mb-6">
                  <h3 className="text-2xl font-bold text-slate-900">
                    {showHouseholdModal === 'create' ? 'Create Household' : 'Join Household'}
                  </h3>
                  <button onClick={() => setShowHouseholdModal(null)} className="p-2 hover:bg-slate-100 rounded-full transition-colors">
                    <X size={24} />
                  </button>
                </div>
                
                <p className="text-slate-500 mb-6">
                  {showHouseholdModal === 'create' 
                    ? 'Give your household a name to start sharing your meal plan.' 
                    : 'Enter the ID shared by your partner to join their household.'}
                </p>

                <div className="space-y-4">
                  <input 
                    type="text"
                    value={householdNameInput}
                    onChange={(e) => setHouseholdNameInput(e.target.value)}
                    placeholder={showHouseholdModal === 'create' ? "e.g. The Smith Kitchen" : "Enter Household ID"}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 outline-none transition-all"
                    autoFocus
                  />
                  
                  <button 
                    onClick={showHouseholdModal === 'create' ? handleCreateHousehold : handleJoinHousehold}
                    disabled={!householdNameInput.trim() || isCreatingHousehold}
                    className="w-full py-3 bg-emerald-600 text-white font-bold rounded-xl hover:bg-emerald-700 transition-all shadow-lg shadow-emerald-100 disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {isCreatingHousehold && <Loader2 size={18} className="animate-spin" />}
                    {showHouseholdModal === 'create' ? 'Create Now' : 'Join Now'}
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Sidebar */}
          <div className="lg:col-span-4 space-y-6">
            {/* Input Form */}
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
              <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Plus size={20} className="text-emerald-500" />
                Add to Plan
              </h2>
              
              <form onSubmit={handleAddMeal} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 uppercase mb-1">Meal Name</label>
                  <input 
                    type="text" 
                    value={newMealName}
                    onChange={(e) => {
                      setNewMealName(e.target.value);
                      if (warning) setWarning(null);
                    }}
                    placeholder="e.g. Grilled Salmon"
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none transition-all"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-400 uppercase mb-1">Meal Type</label>
                  <div className="grid grid-cols-2 gap-2">
                    {(['lunch', 'dinner'] as const).map((type) => (
                      <button
                        key={type}
                        type="button"
                        onClick={() => setSelectedType(type)}
                        className={`py-2 px-4 rounded-xl text-sm font-semibold capitalize transition-all border ${
                          selectedType === type 
                            ? 'bg-emerald-600 text-white border-emerald-600 shadow-md shadow-emerald-100' 
                            : 'bg-white text-slate-600 border-slate-200 hover:border-emerald-200'
                        }`}
                      >
                        {type}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-400 uppercase mb-1">Date</label>
                  <input 
                    type="date" 
                    value={selectedDate}
                    onChange={(e) => setSelectedDate(e.target.value)}
                    min={new Date().toISOString().split('T')[0]}
                    max={days[days.length - 1]}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none transition-all"
                  />
                </div>

                <button 
                  type="submit"
                  disabled={!newMealName.trim()}
                  className="w-full py-3 bg-slate-900 text-white font-semibold rounded-xl hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-slate-200"
                >
                  Save Meal
                </button>
              </form>

              <AnimatePresence>
                {warning && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="mt-4 p-4 bg-amber-50 border border-amber-100 rounded-xl flex gap-3"
                  >
                    <AlertCircle className="text-amber-500 shrink-0" size={20} />
                    <p className="text-sm text-amber-800 leading-tight">{warning}</p>
                  </motion.div>
                )}

                {success && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="mt-4 p-4 bg-emerald-50 border border-emerald-100 rounded-xl flex gap-3"
                  >
                    <CheckCircle2 className="text-emerald-500 shrink-0" size={20} />
                    <p className="text-sm text-emerald-800 leading-tight">{success}</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Pantry Section */}
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
              <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Package size={20} className="text-amber-500" />
                My Pantry
              </h2>
              
              <form onSubmit={handleAddPantry} className="flex gap-2 mb-4">
                <input 
                  type="text" 
                  value={newPantryItem}
                  onChange={(e) => setNewPantryItem(e.target.value)}
                  placeholder="Add item..."
                  className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-amber-500 transition-all"
                />
                <button type="submit" className="p-2 bg-slate-900 text-white rounded-xl hover:bg-slate-800 transition-all">
                  <Plus size={18} />
                </button>
              </form>

              <div className="flex flex-wrap gap-2 mb-6">
                {pantry.map((item) => (
                  <span key={item} className="flex items-center gap-1 px-2 py-1 bg-amber-50 text-amber-800 text-xs font-medium rounded-lg border border-amber-100">
                    {item}
                    <button onClick={() => handleRemovePantry(item)} className="hover:text-amber-600">
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>

              <button 
                onClick={getAiSuggestions}
                disabled={isGenerating || pantry.length === 0}
                className="w-full py-2 bg-amber-500 text-white font-bold rounded-xl hover:bg-amber-600 transition-all flex items-center justify-center gap-2 shadow-lg shadow-amber-100 disabled:opacity-50"
              >
                {isGenerating ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />}
                Suggest Meals
              </button>

              <AnimatePresence>
                {aiSuggestions.length > 0 && (
                  <motion.div 
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    className="mt-4 space-y-2"
                  >
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">AI Ideas</p>
                    {aiSuggestions.map((s) => (
                      <button 
                        key={s}
                        onClick={() => handleAddMeal(undefined, s)}
                        className="w-full text-left p-2 text-xs bg-slate-50 hover:bg-emerald-50 hover:text-emerald-700 rounded-lg border border-slate-100 transition-all flex items-center justify-between group"
                      >
                        {s}
                        <Plus size={12} className="opacity-0 group-hover:opacity-100" />
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* Forecast */}
          <div className="lg:col-span-8">
            <div className="bg-white rounded-3xl shadow-sm border border-slate-100 overflow-hidden">
              <div className="p-6 border-bottom border-slate-50 bg-slate-50/50 flex items-center justify-between">
                <h2 className="font-bold text-slate-800 flex items-center gap-2">
                  <CalendarIcon size={20} className="text-slate-400" />
                  60-Day Forecast
                </h2>
                <span className="text-xs font-medium text-slate-400 bg-white px-3 py-1 rounded-full border border-slate-100">
                  {meals.length} meals planned
                </span>
              </div>

              <div className="divide-y divide-slate-50 max-h-[75vh] overflow-y-auto custom-scrollbar">
                {days.map((date) => {
                  const lunch = meals.find(m => m.date === date && m.type === 'lunch');
                  const dinner = meals.find(m => m.date === date && m.type === 'dinner');
                  const lunchConflict = lunch ? getViolation(lunch) : null;
                  const dinnerConflict = dinner ? getViolation(dinner) : null;
                  const isToday = date === new Date().toISOString().split('T')[0];

                  return (
                    <div 
                      key={date} 
                      onDragOver={onDragOver}
                      onDrop={(e) => onDrop(e, date, 'lunch')} // Default to lunch if dropped on row, but slots have their own
                      className={`flex flex-col md:flex-row md:items-center gap-4 p-4 hover:bg-slate-50/50 transition-colors ${isToday ? 'bg-emerald-50/20' : ''}`}
                    >
                      <div className={`w-12 text-center shrink-0 ${isToday ? 'text-emerald-600' : 'text-slate-400'}`}>
                        <div className="text-[10px] font-bold uppercase tracking-tighter leading-none">
                          {new Date(date).toLocaleDateString('en-US', { weekday: 'short' })}
                        </div>
                        <div className="text-lg font-black leading-none mt-1">
                          {new Date(date).getDate()}
                        </div>
                        <div className="text-[9px] font-medium uppercase mt-1 opacity-60">
                          {new Date(date).toLocaleDateString('en-US', { month: 'short' })}
                        </div>
                      </div>
                      
                      <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {/* Lunch Slot */}
                        <div 
                          onDragOver={onDragOver}
                          onDrop={(e) => { e.stopPropagation(); onDrop(e, date, 'lunch'); }}
                          draggable={!!lunch}
                          onDragStart={(e) => lunch && onDragStart(e, lunch)}
                          className={`p-3 rounded-xl border transition-all flex flex-col cursor-grab active:cursor-grabbing ${
                            lunch 
                              ? lunchConflict 
                                ? 'bg-red-50 border-red-200 shadow-sm' 
                                : 'bg-white border-slate-200 shadow-sm' 
                              : 'bg-slate-50/50 border-dashed border-slate-200 opacity-60'
                          } ${draggedMeal ? 'ring-2 ring-emerald-500 ring-dashed' : ''}`}
                        >
                          <div className="flex justify-between items-center mb-1">
                            <div className="flex items-center gap-1.5">
                              <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Lunch</div>
                              {lunchConflict && (
                                <span 
                                  className="cursor-help" 
                                  title={`Repeat Warning: "${lunch.name}" was also planned on ${formatDate(lunchConflict.date)} (${lunchConflict.type})`}
                                >
                                  <AlertCircle 
                                    size={10} 
                                    className="text-red-500" 
                                  />
                                </span>
                              )}
                            </div>
                            {lunch && (
                              <button 
                                onClick={() => handleRemoveMeal(lunch.id)}
                                className="p-1 text-slate-300 hover:text-red-500 rounded-md transition-all"
                              >
                                <X size={12} />
                              </button>
                            )}
                          </div>
                          <div className="relative group/input">
                            <input 
                              type="text"
                              value={lunch?.name || ''}
                              onChange={(e) => handleInlineEdit(date, 'lunch', e.target.value)}
                              placeholder="Type meal..."
                              className={`w-full bg-transparent font-semibold outline-none text-sm placeholder:text-slate-300 ${
                                lunch 
                                  ? lunchConflict ? 'text-red-900' : 'text-slate-900' 
                                  : 'text-slate-400'
                              }`}
                            />
                            <Edit3 size={10} className="absolute right-0 top-1/2 -translate-y-1/2 text-slate-300 opacity-0 group-hover/input:opacity-100 transition-opacity pointer-events-none" />
                          </div>
                        </div>

                        {/* Dinner Slot */}
                        <div 
                          onDragOver={onDragOver}
                          onDrop={(e) => { e.stopPropagation(); onDrop(e, date, 'dinner'); }}
                          draggable={!!dinner}
                          onDragStart={(e) => dinner && onDragStart(e, dinner)}
                          className={`p-3 rounded-xl border transition-all flex flex-col cursor-grab active:cursor-grabbing ${
                            dinner 
                              ? dinnerConflict 
                                ? 'bg-red-50 border-red-200 shadow-sm' 
                                : 'bg-white border-slate-200 shadow-sm' 
                              : 'bg-slate-50/50 border-dashed border-slate-200 opacity-60'
                          } ${draggedMeal ? 'ring-2 ring-emerald-500 ring-dashed' : ''}`}
                        >
                          <div className="flex justify-between items-center mb-1">
                            <div className="flex items-center gap-1.5">
                              <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Dinner</div>
                              {dinnerConflict && (
                                <span 
                                  className="cursor-help" 
                                  title={`Repeat Warning: "${dinner.name}" was also planned on ${formatDate(dinnerConflict.date)} (${dinnerConflict.type})`}
                                >
                                  <AlertCircle 
                                    size={10} 
                                    className="text-red-500" 
                                  />
                                </span>
                              )}
                            </div>
                            {dinner && (
                              <button 
                                onClick={() => handleRemoveMeal(dinner.id)}
                                className="p-1 text-slate-300 hover:text-red-500 rounded-md transition-all"
                              >
                                <X size={12} />
                              </button>
                            )}
                          </div>
                          <div className="relative group/input">
                            <input 
                              type="text"
                              value={dinner?.name || ''}
                              onChange={(e) => handleInlineEdit(date, 'dinner', e.target.value)}
                              placeholder="Type meal..."
                              className={`w-full bg-transparent font-semibold outline-none text-sm placeholder:text-slate-300 ${
                                dinner 
                                  ? dinnerConflict ? 'text-red-900' : 'text-slate-900' 
                                  : 'text-slate-400'
                              }`}
                            />
                            <Edit3 size={10} className="absolute right-0 top-1/2 -translate-y-1/2 text-slate-300 opacity-0 group-hover/input:opacity-100 transition-opacity pointer-events-none" />
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #E2E8F0;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #CBD5E1;
        }
      `}</style>
    </div>
  );
}
